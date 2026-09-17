# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG METADATA_IMAGE=python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d
ARG NODE_IMAGE=node:26.3.1-bookworm-slim@sha256:9898bb74f4ee319780e87819df703b3633113bc3422f151fd11155cf974a2749

FROM ${METADATA_IMAGE} AS metadata
ARG NODE_IMAGE
ARG SOURCE_DATE_EPOCH=0
WORKDIR /source
COPY . .
RUN python scripts/generate-source-metadata.py \
      --root /source \
      --output /metadata \
      --source-date-epoch "${SOURCE_DATE_EPOCH}" \
      --runtime-name node \
      --runtime-version 26.3.1 \
      --base-image "${NODE_IMAGE}"

FROM ${NODE_IMAGE} AS runtime
ARG NODE_IMAGE
ARG CREATED=1970-01-01T00:00:00Z
ARG VCS_REF=unknown
LABEL org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.description="Hardened browser-free Social Git Core and isolated social workers" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="Social Git runtime" \
      org.opencontainers.image.version="0.1.0" \
      com.social-git.base-image="${NODE_IMAGE}" \
      com.social-git.base-image-source="https://github.com/nodejs/docker-node" \
      com.social-git.node-version="26.3.1"

ENV NODE_ENV=production \
    SOCIAL_GIT_DATA_DIR=/var/lib/social-git \
    SOCIAL_GIT_HOST=0.0.0.0 \
    SOCIAL_GIT_PORT=8080 \
    SOCIAL_GIT_MASTER_KEY_FILE=/run/secrets/social_git_master_key \
    SOCIAL_GIT_AUDIT_KEY_FILE=/run/secrets/social_git_audit_key \
    SOCIAL_GIT_BACKUP_KEY_FILE=/run/secrets/social_git_backup_key \
    SOCIAL_GIT_AUTH_FILE=/run/secrets/social_git_auth \
    SOCIAL_GIT_SESSION_IMPORT_DIR=/var/lib/social-git/import

RUN groupadd --gid 10001 socialgit-core \
    && useradd --uid 10001 --gid 10001 --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin socialgit-core \
    && groupadd --gid 10002 socialgit-worker \
    && useradd --uid 10002 --gid 10002 --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin socialgit-worker \
    && install -d -o 10001 -g 10001 -m 0700 \
      /var/lib/social-git \
      /var/lib/social-git/backups \
      /var/lib/social-git/import \
      /var/lib/social-git/restore \
      /var/lib/social-git/secrets \
    && install -d -o 10001 -g 10001 -m 0755 \
      /opt/social-git \
      /opt/social-git/node_modules \
      /opt/social-git/node_modules/@social-git \
      /opt/social-git/packages \
      /opt/social-git/share

WORKDIR /opt/social-git
COPY --chown=10001:10001 package.json ./package.json
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 web ./web
COPY --chown=10001:10001 runtime/entrypoint.mjs runtime/healthcheck.mjs runtime/backup.mjs runtime/secrets-init.mjs runtime/promote-restore.mjs ./runtime/
COPY --chown=10001:10001 packages/core/package.json ./packages/core/package.json
COPY --chown=10001:10001 packages/core/src ./packages/core/src
COPY --chown=10001:10001 packages/core/migrations ./packages/core/migrations
COPY --chown=10001:10001 packages/reddit-adapter/package.json ./packages/reddit-adapter/package.json
COPY --chown=10001:10001 packages/reddit-adapter/src ./packages/reddit-adapter/src
COPY --chown=10001:10001 packages/reddit-adapter/THIRD_PARTY_NOTICES.md ./share/reddit-adapter-THIRD_PARTY_NOTICES.md
COPY --chown=10001:10001 packages/x-adapter/package.json ./packages/x-adapter/package.json
COPY --chown=10001:10001 packages/x-adapter/src ./packages/x-adapter/src
COPY --chown=10001:10001 packages/x-adapter/THIRD_PARTY_NOTICES.md ./share/x-adapter-THIRD_PARTY_NOTICES.md
COPY --chown=10001:10001 packages/security/package.json ./packages/security/package.json
COPY --chown=10001:10001 packages/security/src ./packages/security/src
COPY --chown=10001:10001 packages/worker-security/package.json ./packages/worker-security/package.json
COPY --chown=10001:10001 packages/worker-security/src ./packages/worker-security/src
COPY --from=metadata --chown=10001:10001 --chmod=0444 \
  /metadata/source-manifest.sha256 \
  /metadata/sbom.spdx.json \
  ./share/

RUN ln -s ../../packages/core node_modules/@social-git/core \
    && ln -s ../../packages/reddit-adapter node_modules/@social-git/reddit-adapter \
    && ln -s ../../packages/x-adapter node_modules/@social-git/x-adapter \
    && ln -s ../../packages/security node_modules/@social-git/security \
    && ln -s ../../packages/worker-security node_modules/@social-git/worker-security \
    && find /opt/social-git -type d -exec chmod 0555 {} + \
    && find /opt/social-git -type f -exec chmod 0444 {} + \
    && find /var/lib/dpkg/info -maxdepth 1 -type f \
      \( -name '*.config' -o -name '*.postinst' -o -name '*.postrm' \
         -o -name '*.preinst' -o -name '*.prerm' -o -name '*.triggers' \) \
      -exec chmod 0444 {} + \
    && rm -rf \
      /etc/apt \
      /etc/cron.daily/apt-compat \
      /etc/cron.daily/dpkg \
      /etc/systemd/system/timers.target.wants/apt-daily-upgrade.timer \
      /etc/systemd/system/timers.target.wants/apt-daily.timer \
      /etc/systemd/system/timers.target.wants/dpkg-db-backup.timer \
      /usr/bin/apt* \
      /usr/bin/deb-systemd-helper \
      /usr/bin/deb-systemd-invoke \
      /usr/bin/debconf* \
      /usr/bin/dpkg* \
      /usr/bin/invoke-rc.d \
      /usr/bin/policy-rc.d \
      /usr/bin/service \
      /usr/bin/start-stop-daemon \
      /usr/bin/ucf \
      /usr/bin/ucfq \
      /usr/bin/ucfr \
      /usr/bin/update-alternatives \
      /usr/lib/apt \
      /usr/lib/dpkg \
      /usr/lib/*/libapt-pkg.so* \
      /usr/lib/*/libapt-private.so* \
      /usr/libexec/dpkg \
      /usr/local/bin/docker-entrypoint.sh \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/include \
      /usr/local/lib/node_modules \
      /usr/sbin/dpkg* \
      /usr/sbin/invoke-rc.d \
      /usr/sbin/policy-rc.d \
      /usr/sbin/service \
      /usr/sbin/start-stop-daemon \
      /usr/sbin/update-alternatives \
      /usr/share/bash-completion/completions/apt* \
      /usr/share/bash-completion/completions/debconf* \
      /usr/share/bash-completion/completions/dpkg* \
      /usr/share/bug/dpkg \
      /usr/share/debconf \
      /usr/share/dpkg \
      /usr/share/perl5/Debconf \
      /usr/share/perl5/Dpkg \
      /var/cache/apt \
      /var/lib/apt

USER 10001:10001
EXPOSE 8080 8081 8082
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "/opt/social-git/runtime/healthcheck.mjs", "/readyz"]
ENTRYPOINT ["node", "/opt/social-git/runtime/entrypoint.mjs"]
CMD ["core"]
