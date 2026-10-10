# Thin per-user layer over the published base image.
#
# Everything here is host-specific - which user logs in, where their home lives -
# so it cannot be baked into the image on Docker Hub. The heavy toolchain comes
# from BASE_IMAGE; this layer builds in seconds.
ARG BASE_IMAGE=bbartolome/tride:latest
FROM ${BASE_IMAGE}

ARG SSH_USER=ubuntu
ARG HOST_HOME_DIR=/home

# Baked as ENV, not just ARG: cmd.sh reads both at container start to install
# the authorized key and repair bind-mount ownership.
ENV SSH_USER=$SSH_USER
ENV HOST_HOME_DIR=$HOST_HOME_DIR

RUN set -eu; \
    home="${HOST_HOME_DIR}/${SSH_USER}"; \
    \
    # Reuse uid 1000 where possible by renaming the stock `ubuntu` account, so
    # bind-mounted files keep a sensible owner on Linux hosts.
    if ! id -u "$SSH_USER" >/dev/null 2>&1; then \
      if getent passwd 1000 >/dev/null 2>&1; then \
        old_user="$(getent passwd 1000 | cut -d: -f1)"; \
        old_group="$(id -gn "$old_user")"; \
        usermod -l "$SSH_USER" "$old_user"; \
        if [ "$old_group" = "$old_user" ]; then groupmod -n "$SSH_USER" "$old_group"; fi; \
      else \
        useradd -u 1000 -m -s /bin/bash "$SSH_USER"; \
      fi; \
    fi; \
    \
    # Point the account at the host-shaped home and populate it from skel.
    # usermod -m is avoided deliberately: it fails when the target already
    # exists, which it does as soon as anything has mounted there.
    usermod -d "$home" -s /bin/bash "$SSH_USER"; \
    mkdir -p "$home"; \
    cp -a /etc/skel/. "$home"/; \
    \
    # No account password at all - sshd is key-only and sudo is NOPASSWD.
    usermod -p '*' "$SSH_USER"; \
    usermod -aG sdkman "$SSH_USER"; \
    \
    printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$SSH_USER" > "/etc/sudoers.d/$SSH_USER"; \
    chmod 0440 "/etc/sudoers.d/$SSH_USER"; \
    \
    # npm's prefix belongs in .npmrc, not in a `npm config set` that would shell
    # out on every single login.
    printf 'prefix=%s/.npm-global\n' "$home" > "$home/.npmrc"; \
    mkdir -p "$home/.npm-global" "$home/.n"; \
    \
    # The web UI realpaths its workspace root at startup and crashes if it is
    # absent, so it must exist even when the host mounts nothing over it.
    mkdir -p "$home/workspace"; \
    \
    # Ubuntu's stock .bashrc returns early for non-interactive shells, and bash
    # sources .bashrc for `ssh host <command>`. Anything a scripted SSH call
    # needs must therefore go ABOVE that guard - appending leaves java, mvn and
    # CHROME_BIN missing for every remote command. Single-quoted so $HOME and
    # $PATH resolve at shell start, not at build time.
    bashrc_tmp="$(mktemp)"; \
    { \
      printf '%s\n' \
        '# --- devcontainer environment (kept above the non-interactive guard) ---' \
        'export N_PREFIX="$HOME/.n"' \
        'export PATH="$N_PREFIX/bin:$HOME/.npm-global/bin:$PATH"' \
        'export CHROME_BIN=/usr/bin/chromium-browser' \
        'export CHROME_HEADLESS_NO_SANDBOX=true' \
        'export SDKMAN_DIR=/opt/sdkman' \
        '[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ] && . "$SDKMAN_DIR/bin/sdkman-init.sh"' \
        '# --- end devcontainer environment ---' \
        ''; \
      cat "$home/.bashrc"; \
    } > "$bashrc_tmp"; \
    cat "$bashrc_tmp" > "$home/.bashrc"; \
    rm -f "$bashrc_tmp"; \
    \
    # The user's own hook stays at the bottom, where interactive customisation
    # belongs.
    printf '%s\n' '[[ -s "$HOME/.bashrc.ext" ]] && source "$HOME/.bashrc.ext"' \
      >> "$home/.bashrc"; \
    \
    chown -R "$SSH_USER:$SSH_USER" "$home"

EXPOSE 22
CMD ["/usr/local/bin/cmd.sh"]
