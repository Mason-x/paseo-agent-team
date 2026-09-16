# syntax=docker/dockerfile:1.7

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS plugin-build
WORKDIR /src/paseo-omp
COPY paseo-omp/package.json paseo-omp/package-lock.json ./
RUN npm ci --ignore-scripts
COPY paseo-omp/ ./

FROM ghcr.io/getpaseo/paseo:0.8.0@sha256:5518da7cdd35f132e8a944c35e509c677a90a8f3ec8a78df98f7fb5fd5e2c6c3

ARG TARGETARCH
ARG OMP_VERSION=18.1.15
ARG OMP_SHA256_AMD64=747518a41fbb32ac47491b4677a7a921d0d9e5977ae006c358d6836813149adc
ARG OMP_SHA256_ARM64=2e1142ccd4bb76413b63a05711ac51c7b95551f36387ef295661bb86f0576189

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=plugin-build --chown=1000:1000 /src/paseo-omp /opt/paseo-omp
COPY --chown=1000:1000 paseo-omp/canary/paseo.config.json /home/paseo/.paseo/config.json
COPY --chown=1000:1000 paseo-omp/canary/models.yml /home/paseo/.omp/agent/models.yml
COPY --chown=1000:1000 paseo-omp/canary/omp.config.yml /home/paseo/.omp/agent/config.yml
RUN case "${TARGETARCH}" in \
      amd64) omp_asset="omp-linux-x64"; omp_sha="${OMP_SHA256_AMD64}" ;; \
      arm64) omp_asset="omp-linux-arm64"; omp_sha="${OMP_SHA256_ARM64}" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && test -n "${omp_sha}" \
  && curl --fail --location --retry 3 --max-time 300 \
    "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/${omp_asset}" \
    --output /usr/local/bin/omp \
  && echo "${omp_sha}  /usr/local/bin/omp" | sha256sum --check --strict \
  && chmod 0755 /usr/local/bin/omp \
  && test "$(/usr/local/bin/omp --version)" = "omp/${OMP_VERSION}"

ENV PASEO_WEB_UI_ENABLED=true
ENV PASEO_LISTEN=0.0.0.0:6767
ENV PASEO_RELAY_ENABLED=false
