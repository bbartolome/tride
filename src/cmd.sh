#!/bin/bash

set -e

# The image doubles as its own installer: `docker run --rm -e SETUP=true <image>`
# prints a host bootstrap script on stdout. Branch before anything else so that
# nothing else can contaminate stdout.
if [ "${SETUP:-}" = "true" ]; then
  exec /usr/local/bin/setup.sh
fi

SOCKET_PATH="/var/run/docker.sock"

ensure_docker_group() {
  if [ ! -S "$SOCKET_PATH" ]; then
    return 0
  fi

  local socket_gid
  socket_gid="$(stat -c '%g' "$SOCKET_PATH")"

  if [ -z "$socket_gid" ]; then
    return 0
  fi

  local group_name
  group_name="$(getent group | awk -F: -v gid="$socket_gid" '$3 == gid { print $1; exit }')"

  if [ -z "$group_name" ]; then
    group_name="docker-host"
    if getent group "$group_name" >/dev/null; then
        group_name="docker-host-${socket_gid}"
    fi
    groupadd -g "$socket_gid" "$group_name"
  fi

  if ! id -nG "$SSH_USER" | tr ' ' '\n' | grep -qx "$group_name"; then
    usermod -aG "$group_name" "$SSH_USER"
  fi

  chgrp "$group_name" "$SOCKET_PATH"
  chmod g+rw "$SOCKET_PATH"
}

# sshd is configured with AuthorizedKeysFile /etc/ssh/authorized_keys/%u, which
# sits outside the user's home on purpose: the host ~/.ssh arrives as a bind
# mount whose ownership and mode cannot be relied on to satisfy StrictModes.
# Copy the key into the root-owned path instead.
install_authorized_keys() {
  local src="${HOST_HOME_DIR}/${SSH_USER}/.ssh/authorized_keys"
  local dest="/etc/ssh/authorized_keys/${SSH_USER}"

  if [ ! -f "$src" ]; then
    echo "cmd.sh: no authorized_keys at $src - SSH logins will be refused" >&2
    return 0
  fi

  mkdir -p /etc/ssh/authorized_keys
  cp "$src" "$dest"
  chown root:root "$dest"
  chmod 644 "$dest"
}

PASSWORD_FILE="/run/devcontainer/sudopass"

# The account ships with no password (usermod -p '*'); one is supplied at run
# time through a mounted file instead, since a published image cannot bake in a
# per-host credential. The file is truncated in place as soon as it has been
# consumed, so the plaintext does not sit on the host indefinitely.
#
# Truncate rather than remove: the mount is bound to that inode, and unlinking
# it would break the mount rather than clear it.
apply_password() {
  [ -f "$PASSWORD_FILE" ] || return 0
  [ -s "$PASSWORD_FILE" ] || return 0

  local password
  password="$(head -n 1 "$PASSWORD_FILE")"

  if [ -z "$password" ]; then
    : > "$PASSWORD_FILE" 2>/dev/null || true
    return 0
  fi

  if printf '%s:%s\n' "$SSH_USER" "$password" | chpasswd; then
    echo "cmd.sh: password set for $SSH_USER" >&2
  else
    echo "cmd.sh: failed to set password for $SSH_USER" >&2
    return 0
  fi

  if : > "$PASSWORD_FILE" 2>/dev/null; then
    echo "cmd.sh: cleared $PASSWORD_FILE" >&2
  else
    echo "cmd.sh: WARNING could not clear $PASSWORD_FILE - it still holds the plaintext" >&2
  fi
}

is_mounted() {
  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "$1"
  else
    grep -q " $1 " /proc/mounts
  fi
}

# Bind-mount targets are created root-owned by Docker before this script runs, so
# the image's build-time ownership no longer covers them. An entry that is itself
# a bind mount gets only its mountpoint inode chowned - recursing into a mounted
# ~/.ssh or ~/workspace would rewrite ownership of the host's own files.
fix_home_ownership() {
  local home_dir="${HOST_HOME_DIR}/${SSH_USER}"

  [ -d "$home_dir" ] || return 0

  chown "$SSH_USER:$SSH_USER" "$home_dir"

  local entry
  for entry in "$home_dir"/* "$home_dir"/.[!.]*; do
    [ -e "$entry" ] || continue
    if is_mounted "$entry"; then
      chown "$SSH_USER:$SSH_USER" "$entry"
    else
      chown -R "$SSH_USER:$SSH_USER" "$entry"
    fi
  done
}

# Config for the unprivileged web-ui process reaches it through a file, not
# inline assignments on a runuser -c line: `runuser -l` resets the
# environment, and quoting a comma-separated allowlist through two shells is
# a footgun. write_webui_env is run as root before start_webui drops
# privilege.
write_webui_env() {
  local env_file="/run/devcontainer/webui.env"
  local admin_logins
  admin_logins="$(printf '%s' "${WEBUI_ADMIN_LOGINS:-}" | tr -d '[:space:]')"

  mkdir -p "$(dirname "$env_file")" || return 0

  {
    printf 'WEBUI_PORT=%s\n' "${WEBUI_PORT:-8088}"
    printf 'WEBUI_HOST=%s\n' "127.0.0.1"
    printf 'WEBUI_DIR=%s\n' "${WEBUI_DIR:-/opt/webui}"
    printf 'WEBUI_STATE_DIR=%s\n' "${WEBUI_STATE_DIR:-/var/lib/devcontainer-webui}"
    printf 'WEBUI_WORKSPACE_ROOT=%s\n' "${HOST_HOME_DIR}/${SSH_USER}/workspace"
    printf 'WEBUI_ADMIN_LOGINS=%s\n' "$admin_logins"
    printf 'WEBUI_TMUX_SOCKET=%s\n' "webui"
    printf 'WEBUI_REQUIRE_AUTH=%s\n' "${WEBUI_REQUIRE_AUTH:-false}"
  } > "$env_file" 2>/dev/null || { echo "cmd.sh: failed to write $env_file - web ui will not start" >&2; return 0; }

  chmod 644 "$env_file" 2>/dev/null || true

  return 0
}

# Starts the Nest web-ui API under the unprivileged SSH_USER, supervised by
# webui-run.sh so a crash there never brings down sshd or the container.
# Must be incapable of returning nonzero: this runs under set -e, and any
# failure here must not prevent sshd from starting.
start_webui() {
  if [ "${WEBUI_ENABLED:-true}" != "true" ]; then
    echo "cmd.sh: WEBUI_ENABLED is not true - skipping web ui" >&2
    return 0
  fi

  local webui_dir="${WEBUI_DIR:-/opt/webui}"
  local state_dir="${WEBUI_STATE_DIR:-/var/lib/devcontainer-webui}"

  if [ ! -f "$webui_dir/api/dist/main.js" ]; then
    echo "cmd.sh: $webui_dir/api/dist/main.js not found (possible bind-mount override of $webui_dir without a build) - skipping web ui" >&2
    return 0
  fi

  write_webui_env

  mkdir -p "$state_dir" 2>/dev/null || { echo "cmd.sh: could not create $state_dir - skipping web ui" >&2; return 0; }
  chown "$SSH_USER:$SSH_USER" "$state_dir" 2>/dev/null || true
  chmod 700 "$state_dir" 2>/dev/null || true

  # `runuser -l` (not su) gives a login shell WITHOUT PAM auth, which is what
  # sources the .bashrc devcontainer block (N_PREFIX, npm-global PATH,
  # SDKMAN) into the api process and every PTY it later spawns. stdout is
  # reserved for the SETUP=true installer script on the host, so all output
  # here is redirected to stderr; backgrounding with & is itself exempt from
  # set -e.
  runuser -l "$SSH_USER" -c /usr/local/bin/webui-run.sh >&2 2>&1 &

  return 0
}

ensure_docker_group

install_authorized_keys
apply_password
fix_home_ownership
start_webui

/usr/sbin/sshd -D
