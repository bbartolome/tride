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
    return
  fi

  local socket_gid
  socket_gid="$(stat -c '%g' "$SOCKET_PATH")"

  if [ -z "$socket_gid" ]; then
    return
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
    return
  fi

  mkdir -p /etc/ssh/authorized_keys
  cp "$src" "$dest"
  chown root:root "$dest"
  chmod 644 "$dest"
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

  [ -d "$home_dir" ] || return

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
fix_home_ownership

/usr/sbin/sshd -D
