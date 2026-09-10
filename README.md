# devcontainer

An SSH-accessible Ubuntu dev container behind a Tailscale sidecar, bind-mounting
your real home directory paths so tooling inside sees the same layout as the
host. Ships Java (SDKMAN), Node, the Docker CLI, `gh`, Chromium and Claude Code.

The heavy image is built once by CI and published to Docker Hub, so setting up a
new host is one command instead of a ~20 minute local build.

## Quick start

```bash
mkdir -p ~/devcontainer && cd ~/devcontainer
docker run --rm -e SETUP=true bbartolome/devcontainer | bash
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
| Tailscale hostname | `$(hostname -s)-devcontainer` | `.env` |
| Local loopback SSH port | `2222` | `.env` |
| Base image | `bbartolome/devcontainer:latest` | `.env` |
| SSH key to authorize | pick from `~/.ssh/*.pub`, or generate one | `~/.ssh/authorized_keys` |
| Tailscale auth key | — | `.secret` (mode 0600) |

It then creates any missing bind-mount sources, writes `.env` and `.secret`, and
runs `docker compose build && docker compose up -d`. Re-running it is safe: your
previous answers become the defaults, and it will not duplicate a key or an
`~/.ssh/config` entry.

## Connecting

```bash
ssh devcontainer                  # via Tailscale, if the wizard added the config entry
ssh -p 2222 <user>@127.0.0.1      # loopback fallback when the tailnet is down
```

Authentication is **key-only**. Password login is disabled and the account has
no password at all; `sudo` inside the container is passwordless.

## How it fits together

The published image is deliberately user-agnostic — it cannot know your username
or where your home lives, so those cannot be baked in upstream.

```
bbartolome/devcontainer          published by CI, all the slow tooling
        │
        └── installer/Dockerfile local, thin, seconds to build
                                 adds your user, home path, sudoers, .bashrc
```

The same image also carries its own installer under `/opt/installer` and hands it
out when run with `SETUP=true`, which is what makes the one-liner work.

Because the installer payload is copied into the image at build time, changes to
`src/installer/**` only reach users after CI republishes the image.

## Repo layout

```
Dockerfile                     the published base image
src/cmd.sh                     entrypoint: SETUP dispatch, key install, then sshd
src/setup.sh                   emits the host bootstrap script
src/installer/Dockerfile       thin per-user layer over the base
src/installer/docker-compose.yml
src/installer/wizard.sh        host-side setup wizard
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
