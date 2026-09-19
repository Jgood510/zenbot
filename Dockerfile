# Zenbot revival — Node 20 build.
# MongoDB is expected externally (see docker-compose.yml); trade storage,
# backfill and sim all require it.
FROM node:20-bookworm AS builder

# Optional proxy for sandboxed/offline build environments.
# Empty by default (no behavior change); pass --build-arg HTTP_PROXY=...
# when the build host needs a proxy to reach npm/Debian.
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
# Optional PEM CA bundle for TLS-intercepting build proxies. Empty by
# default (no behavior change); pass --build-arg CA_PEM="$(cat ca.pem)"
# and npm/Node will trust it for the install below. The file never leaves
# the builder stage.
ARG CA_PEM=""
ENV http_proxy="${HTTP_PROXY}" https_proxy="${HTTPS_PROXY}" \
    HTTP_PROXY="${HTTP_PROXY}" HTTPS_PROXY="${HTTPS_PROXY}"

# NOTE: the optional native `tulind`/`talib` indicator libraries are deliberately
# NOT built here. Their 2018-era native code does not compile on modern Node,
# so tulind-based strategies are unavailable in this revival (documented in
# README.md). Everything else — backfill, sim, paper trade, genetic
# optimization — runs on the pure-JS path.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ADD . /app
WORKDIR /app
# If CA_PEM was supplied (TLS-intercepting proxy), trust it for npm/Node
# fetches. Absent CA_PEM this is a no-op: normal builds are unaffected.
RUN if [ -n "$CA_PEM" ]; then printf '%s' "$CA_PEM" > /tmp/egress-ca.pem && export NODE_EXTRA_CA_CERTS=/tmp/egress-ca.pem; fi && \
    npm install --unsafe-perm --no-audit --no-fund \
  && (cd scripts/genetic_backtester && npm install --no-audit --no-fund)

FROM node:20-bookworm-slim
COPY --chown=node --from=builder /app/node_modules /app/node_modules/
COPY --chown=node --from=builder /app/scripts/genetic_backtester/node_modules /app/scripts/genetic_backtester/node_modules/

WORKDIR /app
RUN chown -R node:node /app
COPY --chown=node . /app

USER node
ENV NODE_ENV=production

ENTRYPOINT ["/app/zenbot.sh"]
CMD ["trade", "--paper"]
