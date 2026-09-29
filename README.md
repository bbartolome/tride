# TRIDE

Tailscale-based Remote IDE

An SSH-accessible Ubuntu dev container behind a Tailscale sidecar, bind-mounting
your real home directory paths so tooling inside sees the same layout as the
host. Ships Java (SDKMAN), Node, the Docker CLI, `gh`, Chromium and Claude Code.

The heavy image is built once by CI and published to Docker Hub, so setting up a
new host is one command instead of a ~20 minute local build.

## Quick start

```bash
mkdir -p ~/devcontainer && cd ~/devcontainer
docker run --rm -e SETUP=true bbartolome/tride | bash
```

That prints a bootstrap script and pipes it to your shell. The script extracts
the installer files into the current directory and starts a wizard.

> Use `docker run --rm`, not `docker exec`, and do not add `-t`. `docker exec`
> attaches to an already-running container, and a TTY would corrupt the pipe.

The wizard asks for:

| Prompt | Default | Goes to |
| --- | --- | --- |
| Username inside the container | your host username | `.env` |
| Parent directory for its home | `dirname $HOME` (`/Users` on macOS) | `.env` |
| Tailscale hostname | `tride` | `.env` |
| Local loopback SSH port | `2222` | `.env` |
| Base image | `bbartolome/tride:latest` | `.env` |
| SSH key to authorize | pick from `~/.ssh/*.pub`, or generate one | `~/.ssh/authorized_keys` |
| Account password | blank (account stays locked) | `.sudopass` (mode 0600) |
| Tailscale auth key | — | `.secret` (mode 0600) |
| Enable the web UI? | `Y` | `.env` (`WEBUI_ENABLED`) |
| Admin logins (comma-separated Tailscale logins) | auto-filled from `tailscale status --json` when that's available on the host, otherwise blank | `.env` (`WEBUI_ADMIN_LOGINS`) |

It then creates any missing bind-mount sources, writes `.env` and `.secret`, and
runs `docker compose build && docker compose up -d`. Re-running it is safe: your
previous answers become the defaults, and it will not duplicate a key or an
`~/.ssh/config` entry.

The web UI's port (`WEBUI_PORT`, default `8088`) isn't part of the prompt flow —
it defaults to `8088` and only changes if you edit `.env` by hand and re-run
`docker compose up -d`.

## Connecting

```bash
ssh devcontainer                  # via Tailscale, if the wizard added the config entry
ssh -p 2222 <user>@127.0.0.1      # loopback fallback when the tailnet is down
```

SSH authentication is **key-only** — password login over SSH is disabled and
cannot be enabled by setting an account password.

The account password the wizard asks for is for `sudo` prompts and `su` inside
the container. `sudo` itself remains `NOPASSWD`, so it will not prompt; the
password matters for anything else that authenticates the account. Leaving the
prompt blank keeps the account locked, which is a valid setup.

The password reaches the container through `.sudopass`, bind-mounted at
`/run/devcontainer/sudopass`. On the first start `cmd.sh` applies it and then
truncates that file in place, so the plaintext does not linger on the host.

> Because the file is cleared after use, the password does **not** survive the
> container being *recreated* (an image update, `up --force-recreate`) — a plain
> restart is fine. Re-run `./wizard.sh` to set it again.

## Web UI

If the wizard enabled it, the web UI is at **`http://tride`** — plain HTTP on
port 80, not HTTPS. That's deliberate: Tailscale only issues a certificate for
the full `tride.<tailnet>.ts.net` name, so `https://tride` would always throw a
name-mismatch warning. Traffic inside the tailnet is already WireGuard-encrypted,
so plain HTTP there isn't the exposure it looks like from the outside.

**Prerequisite:** MagicDNS must be enabled in your tailnet's admin console so
`tride` resolves at all. You do not need to set up HTTPS certificates for
this — the UI is served over HTTP.

**Auth model:** Tailscale injects an identity header on every request; the UI
checks the login against an allowlist. `WEBUI_ADMIN_LOGINS` seeds admins who
can never be removed or demoted through the UI itself — that's the lockout
guard — and admins manage everyone else at `/admin/users`. There is
deliberately **no read-only role**: anyone who can open a terminal can already
do anything (run arbitrary commands, read any file), so a read-only tier would
be security theatre, not a real restriction.

**What it does:** browse `~/workspace`, see changed files and diffs, stage,
unstage, discard and commit, stash and pop, switch and create branches, fetch,
pull and push, and open real terminals.

**What it deliberately does not do:** merge, rebase, cherry-pick and conflict
resolution are not exposed in the UI. Every repo page has an "Open terminal
here" button — that's the intended way to do anything the UI doesn't cover, not
a gap to route around.

### Terminals

Terminals are backed by tmux on a private socket (`webui`), so browser sessions
never collide with any tmux you run yourself over SSH. Sessions survive a
dropped connection, a phone locking, and a restart of the web UI process
itself.

Escape hatch if the browser is unavailable:

```bash
ssh devcontainer
tmux -L webui attach -t <id>
```

`/tmp` is a Docker `VOLUME`, which means tmux's session state (and anything
else under `/tmp`) survives a plain `restart` but **not**
`docker compose up --force-recreate` — worth knowing before that wipes out a
long-running build you were watching in a terminal tab.

Launching Claude Code from a repo page runs `claude --remote-control` in its
own tmux session. A second launch from the same repo attaches to that existing
session instead of starting a second Claude against one working tree.

## Security note

The identity check guards against **tailnet peers** — it does nothing against
anything already running inside the container. Anyone with a shell there can
`curl 127.0.0.1:8088` with a forged identity header and get in as anyone. Given
that the Docker socket is already bind-mounted into the container, this doesn't
grant an attacker anything they didn't already have — but it's worth knowing
where the boundary actually is.

Related: **never enable Tailscale Funnel** for this hostname. Funnel traffic
carries no identity headers at all, so turning it on would expose the UI to
the entire internet with no auth.

## How it fits together

The published image is deliberately user-agnostic — it cannot know your username
or where your home lives, so those cannot be baked in upstream.

```
bbartolome/tride                 published by CI, all the slow tooling
        │
        └── installer/Dockerfile local, thin, seconds to build
                                 adds your user, home path, sudoers, .bashrc
```

The same image also carries its own installer under `/opt/installer` and hands it
out when run with `SETUP=true`, which is what makes the one-liner work.

Because the installer payload is copied into the image at build time, changes to
`src/installer/**` only reach users after CI republishes the image. The same is
true of `src/webui/**`: the web UI is built and baked into the base image, not
pulled in at container start, so a code change there needs a republish too.

> **Migrated from `bbartolome/devcontainer`:** the published image is now
> `bbartolome/tride`. If your `.env` still pins the old
> `bbartolome/devcontainer` name, you're pulling a repository that no longer
> receives updates. Re-run `./wizard.sh` (it will offer the new default), or
> edit `BASE_IMAGE` in `.env` by hand and run `docker compose up -d`.

## Repo layout

```
Dockerfile                     the published base image
src/cmd.sh                     entrypoint: SETUP dispatch, key install, then sshd
src/setup.sh                   emits the host bootstrap script
src/webui/api                  NestJS backend for the web UI
src/webui/web                  Angular frontend for the web UI
src/webui-run.sh               supervisor that keeps the web UI alive alongside sshd
src/webui-tmux.conf            tmux config for the web UI's terminal sessions
src/installer/Dockerfile       thin per-user layer over the base
src/installer/docker-compose.yml
src/installer/wizard.sh        host-side setup wizard
.dockerignore                  keeps webui build artifacts out of the build context
.github/workflows/ci.yml       lint/build/test on src/webui/** (api + web)
.github/workflows/publish.yml  native arm64 + amd64 build, manifest merge, smoke test
```

## Publishing

CI builds each architecture natively (`ubuntu-24.04` and `ubuntu-24.04-arm`),
pushes each by digest, then merges one multi-arch manifest. It runs on pushes to
`main`, on `v*` tags, and on demand.

Two repository secrets are required:

| Secret | Value |
| --- | --- |
| `DOCKERHUB_USERNAME` | your Docker Hub username |
| `DOCKERHUB_TOKEN` | a Docker Hub access token with Read/Write |

Tags published: `latest` on `main`, `sha-<short>` on every build, and semver
tags (`1.2.3`, `1.2`) for `v*` tags.
