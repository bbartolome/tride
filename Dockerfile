FROM ubuntu:noble

# Avoid prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y openssh-server sudo bash-completion keychain dos2unix curl zip unzip vim git gnupg nodejs npm
RUN apt-get clean

WORKDIR /root

# Create the SSH directory and configure permissions
RUN mkdir /var/run/sshd

# Generate SSH host keys
RUN ssh-keygen -A
RUN chown root:root /etc/ssh/ssh_host_*_key
RUN chmod 600 /etc/ssh/ssh_host_*_key
RUN for key in /etc/ssh/ssh_host_*_key; do echo "HostKey $key"; done | tee -a /etc/ssh/sshd_config

# Key-only SSH. AuthorizedKeysFile deliberately points outside the user's home:
# the compose file bind-mounts the host ~/.ssh, and Docker Desktop's file sharing
# does not reliably preserve the ownership/mode that sshd's StrictModes demands.
# cmd.sh copies the key into this root-owned path at startup instead.
RUN mkdir -p /etc/ssh/authorized_keys && \
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nPubkeyAuthentication yes\nAuthorizedKeysFile /etc/ssh/authorized_keys/%%u\n' \
    >> /etc/ssh/sshd_config

# Install Docker CLI bash completions
RUN for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do apt-get remove $pkg; done
RUN curl -fSL https://raw.githubusercontent.com/docker/cli/master/contrib/completion/bash/docker -o /etc/bash_completion.d/docker \
    && curl -fSL https://raw.githubusercontent.com/docker/compose/master/contrib/completion/bash/docker-compose -o /etc/bash_completion.d/docker-compose

# Add Docker's official GPG key
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository to Apt sources:
RUN echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \"${UBUNTU_CODENAME:-$VERSION_CODENAME}\") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && apt-get update

RUN apt-get -y install docker-ce-cli

# Chrome for testing
RUN apt-get update && apt-get install -y chromium-browser
RUN echo "export CHROME_BIN=/usr/bin/chromium-browser" >> ~/.bashrc
RUN echo "export CHROME_HEADLESS_NO_SANDBOX=true" >> ~/.bashrc

# GitHub CLI
RUN (type -p wget >/dev/null || (apt update && apt install wget -y)) \
	&& mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& apt update
RUN apt-get install -y gh

# Node
RUN bash -c "npm install -g n && n lts"

# Claude Code CLI — the read-only "navigator" the claude-navigator MCP server shells out to.
RUN npm install -g @anthropic-ai/claude-code

# SDKMAN lives in a shared location so any runtime user can use it — this is what
# keeps the per-user installer layer cheap. Group-writable by `sdkman` so a later
# `sdk install` still works for the container user; the installer layer adds that
# user to the group. SDKMAN_DIR must be set before the installer runs, or it falls
# back to $HOME/.sdkman.
ENV SDKMAN_DIR=/opt/sdkman
RUN groupadd -g 2000 sdkman
RUN bash -c "curl -fsSL https://get.sdkman.io | bash && source $SDKMAN_DIR/bin/sdkman-init.sh \
    && sdk install java 25.0.3-tem && sdk install maven 3.9.10"
RUN chgrp -R sdkman $SDKMAN_DIR && chmod -R g+rwX $SDKMAN_DIR
RUN printf 'export SDKMAN_DIR=/opt/sdkman\n[[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]] && source "$SDKMAN_DIR/bin/sdkman-init.sh"\n' \
    > /etc/profile.d/sdkman.sh

# Expose SSH port
EXPOSE 22
VOLUME ["/tmp"]

# Kept late on purpose: a changing IMAGE_REF then only busts the cheap COPY layers
# below it, not the expensive apt/SDKMAN layers above.
ARG IMAGE_REF=bbartolome/devcontainer:latest
ENV DEVCONTAINER_IMAGE=$IMAGE_REF

COPY src/cmd.sh /usr/local/bin/cmd.sh
COPY src/setup.sh /usr/local/bin/setup.sh
COPY src/installer /opt/installer
RUN chmod +x /usr/local/bin/cmd.sh /usr/local/bin/setup.sh

CMD ["/usr/local/bin/cmd.sh"]
