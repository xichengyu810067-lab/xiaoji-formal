FROM ghcr.io/lavalink-devs/lavalink:4.2.2@sha256:87ae53e60dc147c9dddb28e126ce503a26bc8d1477ed8d99543614677882afff

USER root

ARG YTDLP_VERSION=2026.07.04
ARG YTDLP_SHA256=495be29ff4d9d4e9be7eabdfef225221e5d5282e77f2f505abc6dca80349f3fd
ARG DENO_VERSION=2.9.5
ARG DENO_SHA256=8b010a3b1a4a0188a67cdb8a7a27348b2a501af78aec7fc74f2ace167368d530

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 unzip \
    && curl --fail --location --silent --show-error \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
      --output /usr/local/bin/yt-dlp \
    && echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && curl --fail --location --silent --show-error \
      "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" \
      --output /tmp/deno.zip \
    && echo "${DENO_SHA256}  /tmp/deno.zip" | sha256sum --check --strict \
    && unzip -q /tmp/deno.zip -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/deno \
    && /usr/local/bin/yt-dlp --version | grep -Fx "${YTDLP_VERSION}" \
    && /usr/local/bin/deno --version | head -n 1 | grep -Fx "deno ${DENO_VERSION} (stable, release, x86_64-unknown-linux-gnu)" \
    && rm -f /tmp/deno.zip \
    && rm -rf /var/lib/apt/lists/*

USER lavalink

COPY --chown=322:322 application.yml /opt/Lavalink/application.yml
