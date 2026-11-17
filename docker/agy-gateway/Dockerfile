# syntax=docker/dockerfile:1.7
#
# agy-gateway — one container per Antigravity account.
#
#   docker build -t ultrarouter/agy-gateway:1.5.9 docker/agy-gateway
#   docker run -d --name agy-01 \
#     -p 127.0.0.1:20801:8787 \
#     -v agy-01:/data \
#     -e GATEWAY_TOKEN=... \
#     ultrarouter/agy-gateway:1.5.9
#
# Linux requirements for `agy` (per Google docs): glibc >= 2.28, glibcxx >= 3.4.25
# → Debian bookworm (glibc 2.36) is fine.

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# Which agy build this image must contain. The build fails if the installer
# pulls a different version, so an image tag always matches the CLI inside.
ARG AGY_VERSION=1.5.9

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/data \
    NODE_ENV=production \
    AGY_BIN=/usr/local/bin/agy \
    AGY_WORKDIR=/data/work \
    AGY_MODE=auto \
    PORT=8787

# Linux agy keeps its OAuth session in a file
# ($HOME/.gemini/antigravity-cli/antigravity-oauth-token), not in a keyring, so
# the image needs no dbus/gnome-keyring (the Windows build uses Credential
# Manager instead).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Everything runs as uid 10001 (see USER below). /data ownership is baked in so
# a fresh named volume inherits it; the container drops ALL capabilities.
RUN groupadd --gid 10001 agy \
    && useradd --uid 10001 --gid agy --home-dir /data --no-create-home --shell /bin/bash agy \
    && mkdir -p /data/work /data/.gemini \
    && chown -R 10001:10001 /data

# Official installer → ~/.local/bin/agy. HOME must be /root during install (the
# image sets HOME=/data for runtime), otherwise the binary lands in the volume.
RUN curl -fsSL https://antigravity.google/cli/install.sh | HOME=/root bash \
    && install -m 0755 /root/.local/bin/agy /usr/local/bin/agy \
    && test -x /usr/local/bin/agy \
    && INSTALLED="$(/usr/local/bin/agy --version 2>/dev/null | head -n1 | tr -d '\r')" \
    && echo "agy installed: ${INSTALLED}" \
    && case "${INSTALLED}" in "${AGY_VERSION}"*) ;; *) \
         echo "ERROR: image expects agy ${AGY_VERSION} but the installer produced '${INSTALLED}'." >&2; \
         echo "Bump AGY_VERSION in docker/agy-gateway/Dockerfile and the provider tag." >&2; \
         exit 1 ;; \
       esac

WORKDIR /app
COPY lib.mjs gateway.mjs models.json entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh \
    && mkdir -p /data/work

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The CLI and gateway share the unprivileged uid; the image's /data ownership is
# copied into a fresh named volume, so no root-to-user switch is needed (the
# container drops ALL capabilities).
USER 10001:10001
ENTRYPOINT ["/app/entrypoint.sh"]
