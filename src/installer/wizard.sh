#!/usr/bin/env bash
#
# Runs on the HOST. Populates .env and .secret, makes sure an SSH key can log
# in, and brings the stack up. Safe to re-run: existing answers become the
# defaults.
#
# Kept to bash 3.2 features, because that is what macOS still ships.

set -euo pipefail

die()  { printf 'wizard: %s\n' "$*" >&2; exit 1; }
note() { printf 'wizard: %s\n' "$*" >&2; }

# The bootstrap execs us with stdin already pointed at the terminal, but a
# direct ./wizard.sh run may not be. Bind fd 3 to the tty either way.
if [ -t 0 ]; then
  exec 3<&0
elif (exec 3</dev/tty) 2>/dev/null; then
  exec 3</dev/tty
else
  die "no terminal available for prompts - run ./wizard.sh from an interactive shell"
fi

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"

cd "$(dirname "$0")"

[ -f docker-compose.yml ] || die "docker-compose.yml not found in $PWD"

# ---------------------------------------------------------------- helpers ---

# Last value wins, matching how compose itself reads .env.
env_get() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -1
}

ask() { # ask VARNAME "prompt" "default"
  local __var="$1" __prompt="$2" __default="$3" __reply
  printf '  %s [%s]: ' "$__prompt" "$__default" >&2
  IFS= read -r __reply <&3 || { printf '\n' >&2; die "input ended unexpectedly - aborting"; }
  [ -n "$__reply" ] || __reply="$__default"
  printf -v "$__var" '%s' "$__reply"
}

confirm() { # confirm "prompt" "Y"|"N"  -> returns 0 for yes
  local __prompt="$1" __default="$2" __reply __hint
  if [ "$__default" = "Y" ]; then __hint="[Y/n]"; else __hint="[y/N]"; fi
  printf '  %s %s: ' "$__prompt" "$__hint" >&2
  IFS= read -r __reply <&3 || { printf '\n' >&2; die "input ended unexpectedly - aborting"; }
  [ -n "$__reply" ] || __reply="$__default"
  case "$__reply" in [yY]*) return 0 ;; *) return 1 ;; esac
}

# ------------------------------------------------------------------ config ---

printf '\n== devcontainer setup ==\n\n' >&2
note "answers are written to .env (config) and .secret (credentials)"
printf '\n' >&2

default_user="$(env_get SSH_USER)";        [ -n "$default_user" ] || default_user="$(id -un)"
default_homedir="$(env_get HOST_HOME_DIR)"; [ -n "$default_homedir" ] || default_homedir="$(dirname "$HOME")"
default_tshost="$(env_get TS_HOSTNAME)"
[ -n "$default_tshost" ] || default_tshost="dev"
default_port="$(env_get SSH_PORT)";        [ -n "$default_port" ] || default_port="2222"
default_base="${BASE_IMAGE:-}"
[ -n "$default_base" ] || default_base="$(env_get BASE_IMAGE)"
[ -n "$default_base" ] || default_base="bbartolome/tride:latest"

ask SSH_USER      "Username inside the container" "$default_user"
ask HOST_HOME_DIR "Parent directory for its home" "$default_homedir"
ask TS_HOSTNAME   "Tailscale hostname"            "$default_tshost"
ask SSH_PORT      "Local loopback SSH port"       "$default_port"
ask BASE_IMAGE    "Base image"                    "$default_base"

case "$HOST_HOME_DIR" in
  /*) ;;
  *) die "HOST_HOME_DIR must be an absolute path (got '$HOST_HOME_DIR')" ;;
esac

# ----------------------------------------------------------------- ssh key ---

printf '\n== SSH key ==\n\n' >&2
note "the container is key-only; password login is disabled"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

pubkeys=()
for pub in "$HOME"/.ssh/*.pub; do
  [ -f "$pub" ] && pubkeys+=("$pub")
done

printf '\n' >&2
i=1
for pub in ${pubkeys[@]+"${pubkeys[@]}"}; do
  printf '   %d) %s  (%s)\n' "$i" "$(basename "$pub")" "$(awk '{print $1}' "$pub")" >&2
  i=$((i + 1))
done
printf '   g) generate a new dedicated key (devcontainer_ed25519)\n\n' >&2

chosen=""
generated=false
while [ -z "$chosen" ]; do
  if [ ${#pubkeys[@]} -gt 0 ]; then
    ask keychoice "Key to authorize (1-$((i - 1)), or g)" "1"
  else
    ask keychoice "No existing keys found - press enter to generate" "g"
  fi

  case "$keychoice" in
    [gG])
      keyfile="$HOME/.ssh/devcontainer_ed25519"
      if [ -f "$keyfile" ]; then
        note "reusing existing $keyfile"
      else
        ssh-keygen -t ed25519 -N "" -C "devcontainer" -f "$keyfile" >/dev/null
        note "generated $keyfile"
      fi
      chosen="${keyfile}.pub"
      generated=true
      ;;
    ''|*[!0-9]*)
      note "please enter a number from the list, or g"
      ;;
    *)
      if [ "$keychoice" -ge 1 ] && [ "$keychoice" -le ${#pubkeys[@]} ]; then
        chosen="${pubkeys[$((keychoice - 1))]}"
      else
        note "please enter a number from the list, or g"
      fi
      ;;
  esac
done

note "authorizing $(basename "$chosen")"

# The container reads this file through the bind-mounted ~/.ssh.
pubdata="$(cat "$chosen")"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if grep -qxF "$pubdata" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
  note "already present in authorized_keys"
else
  printf '%s\n' "$pubdata" >> "$HOME/.ssh/authorized_keys"
  note "appended to authorized_keys"
fi

# Only offered when absent, so an existing entry is never rewritten.
if [ -f "$HOME/.ssh/config" ] && grep -qE '^[[:space:]]*Host[[:space:]]+devcontainer[[:space:]]*$' "$HOME/.ssh/config"; then
  note "~/.ssh/config already defines 'Host devcontainer' - leaving it alone"
elif confirm "Add a 'Host devcontainer' entry to ~/.ssh/config so 'ssh devcontainer' works?" "Y"; then
  {
    printf '\nHost devcontainer\n'
    printf '    HostName %s\n' "$TS_HOSTNAME"
    printf '    User %s\n' "$SSH_USER"
    printf '    IdentityFile %s\n' "${chosen%.pub}"
  } >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"
  note "added 'Host devcontainer' to ~/.ssh/config"
fi

# -------------------------------------------------------------- tailscale ---

printf '\n== Account password ==\n\n' >&2

note "used for sudo prompts and su; SSH login stays key-only"
note "leave blank to keep the account without a password"

while :; do
  printf '  Password for %s (hidden): ' "$SSH_USER" >&2
  IFS= read -rs sudo_password <&3 || { printf '\n' >&2; die "input ended unexpectedly - aborting"; }
  printf '\n' >&2

  if [ -z "$sudo_password" ]; then
    note "no password set - the account stays locked"
    break
  fi

  printf '  Confirm: ' >&2
  IFS= read -rs sudo_password_confirm <&3 || { printf '\n' >&2; die "input ended unexpectedly - aborting"; }
  printf '\n' >&2

  if [ "$sudo_password" = "$sudo_password_confirm" ]; then
    break
  fi
  note "passwords did not match - try again"
done

printf '\n== Tailscale ==\n\n' >&2

existing_authkey=""
if [ -f .secret ]; then
  existing_authkey="$(sed -n 's/^TS_AUTHKEY=//p' .secret | tail -1)"
fi

if [ -n "$existing_authkey" ]; then
  printf '  Tailscale auth key (hidden, enter to keep existing): ' >&2
else
  printf '  Tailscale auth key (hidden, enter to skip): ' >&2
fi
IFS= read -rs TS_AUTHKEY <&3 || { printf '\n' >&2; die "input ended unexpectedly - aborting"; }
printf '\n' >&2
[ -n "$TS_AUTHKEY" ] || TS_AUTHKEY="$existing_authkey"
[ -n "$TS_AUTHKEY" ] || note "no auth key set - tailscale will need 'tailscale up' run by hand"

# ------------------------------------------------- host-side mount sources ---

printf '\n== Host paths ==\n\n' >&2

# Docker creates a DIRECTORY for any missing bind-mount source, which silently
# breaks the entries that are meant to be files.
for f in .gitconfig .bashrc.ext; do
  if [ -d "$HOME/$f" ]; then
    die "$HOME/$f is a directory but must be a file - remove it and re-run"
  fi
  [ -e "$HOME/$f" ] || { touch "$HOME/$f"; note "created $HOME/$f"; }
done

for d in .ssh .cline .claude Cline .vscode-server workspace; do
  [ -e "$HOME/$d" ] || { mkdir -p "$HOME/$d"; note "created $HOME/$d/"; }
done

# ------------------------------------------------------------------ output ---

cat > .env <<EOF
# Written by wizard.sh - re-run it to change these.
SSH_USER=$SSH_USER
HOST_HOME_DIR=$HOST_HOME_DIR
HOME=$HOME
TS_HOSTNAME=$TS_HOSTNAME
SSH_PORT=$SSH_PORT
BASE_IMAGE=$BASE_IMAGE
EOF
chmod 644 .env

# env_file makes .secret mandatory, so it is written even when empty.
( umask 077; printf 'TS_AUTHKEY=%s\n' "$TS_AUTHKEY" > .secret )
chmod 600 .secret

# Always created, even when empty: compose bind-mounts this path, and Docker
# would otherwise materialise it as a directory. cmd.sh consumes the password
# on first start and truncates the file in place.
( umask 077; printf '%s\n' "$sudo_password" > .sudopass )
chmod 600 .sudopass

printf '\n' >&2
note "wrote .env, .secret and .sudopass (0600)"

# ------------------------------------------------------------------- start ---

printf '\n' >&2
if ! confirm "Build and start the stack now?" "Y"; then
  note "skipped - run 'docker compose build && docker compose up -d' when ready"
  exit 0
fi

printf '\n' >&2
if ! docker compose build --pull; then
  note "build with --pull failed; retrying without it (a local base image?)"
  docker compose build
fi
docker compose up -d

printf '\n' >&2
note "up. connect with:"
printf '    ssh devcontainer\n' >&2
printf '    ssh -p %s %s@127.0.0.1      (loopback fallback)\n' "$SSH_PORT" "$SSH_USER" >&2
printf '\n' >&2
