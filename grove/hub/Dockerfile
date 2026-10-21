# Grove Hub: Google Scion Hub + web dashboard, reachable only through Tailscale.
# Built by Railway from grove/hub. No container runtime inside: agents run on the broker VM.

ARG SCION_TAG=nightly-20261021
# GitHub release asset digest for scion-linux-amd64.tar.gz at nightly-20261021 (commit a44a186).
ARG SCION_SHA256=d18882a6c3564349dff6dfabe60421dbdf9489310ab6f34f1331574f66b9d7a8
ARG TAILSCALE_VERSION=v1.104.1

FROM tailscale/tailscale:${TAILSCALE_VERSION} AS tailscale

FROM debian:bookworm-slim AS fetch
ARG SCION_TAG
ARG SCION_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    curl -fsSL -o /tmp/scion.tgz \
      "https://github.com/GoogleCloudPlatform/scion/releases/download/${SCION_TAG}/scion-linux-amd64.tar.gz"; \
    echo "${SCION_SHA256}  /tmp/scion.tgz" | sha256sum -c -; \
    mkdir -p /tmp/scion /out; \
    tar -xzf /tmp/scion.tgz -C /tmp/scion; \
    bin="$(find /tmp/scion -type f -name scion | head -n 1)"; \
    test -n "$bin"; \
    install -m 0755 "$bin" /out/scion

# Final stage starts clean so nothing from the fetch stage (tarballs, curl) reaches runtime.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /out/scion /usr/local/bin/scion
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/grove-hub-entrypoint
RUN chmod 0755 /usr/local/bin/grove-hub-entrypoint

# Runs as root because Railway mounts volumes root-owned. The container is unprivileged on Railway.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/grove-hub-entrypoint"]
