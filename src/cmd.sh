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

ensure_docker_group

install_authorized_keys
apply_password
fix_home_ownership

/usr/sbin/sshd -D
