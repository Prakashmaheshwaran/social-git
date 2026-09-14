# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG PYTHON_IMAGE=python:3.13.7-slim-bookworm@sha256:adafcc17694d715c905b4c7bebd96907a1fd5cf183395f0ebc4d3428bd22d92d

FROM ${PYTHON_IMAGE} AS metadata
ARG PYTHON_IMAGE
ARG SOURCE_DATE_EPOCH=0
WORKDIR /source
COPY . .
RUN python scripts/generate-source-metadata.py \
      --root /source \
      --output /metadata \
      --source-date-epoch "${SOURCE_DATE_EPOCH}" \
      --runtime-version 3.13.7 \
      --base-image "${PYTHON_IMAGE}"

FROM ${PYTHON_IMAGE} AS runtime
ARG PYTHON_IMAGE
ARG CREATED=1970-01-01T00:00:00Z
ARG VCS_REF=unknown
LABEL org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.description="Hardened browser-free Social Git core and worker runtime" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="Social Git runtime" \
      org.opencontainers.image.version="0.1.0" \
      com.social-git.base-image="${PYTHON_IMAGE}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=0 \
    PYTHONUNBUFFERED=1 \
    SOCIAL_GIT_DATABASE_PATH=/var/lib/social-git/social-git.sqlite3 \
    SOCIAL_GIT_HOST=0.0.0.0 \
    SOCIAL_GIT_PORT=8080 \
    SOCIAL_GIT_SESSION_KEY_FILE=/run/secrets/social_git_session_key

RUN groupadd --gid 10001 socialgit \
    && useradd --uid 10001 --gid 10001 --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin socialgit \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/social-git \
    && install -d -o 10001 -g 10001 -m 0755 /opt/social-git/share

WORKDIR /opt/social-git
COPY --chown=10001:10001 runtime ./runtime
COPY --from=metadata --chown=10001:10001 --chmod=0444 \
  /metadata/source-manifest.sha256 \
  /metadata/sbom.spdx.json \
  ./share/
RUN find /opt/social-git/runtime -type d -exec chmod 0555 {} + \
    && find /opt/social-git/runtime -type f -exec chmod 0444 {} + \
    && rm -rf \
      /etc/apt \
      /etc/cron.daily/apt-compat \
      /etc/cron.daily/dpkg \
      /etc/systemd/system/timers.target.wants/apt-daily-upgrade.timer \
      /etc/systemd/system/timers.target.wants/apt-daily.timer \
      /etc/systemd/system/timers.target.wants/dpkg-db-backup.timer \
      /usr/bin/apt* \
      /usr/bin/dpkg* \
      /usr/lib/apt \
      /usr/lib/dpkg \
      /usr/libexec/dpkg \
      /usr/local/bin/pip \
      /usr/local/bin/pip3 \
      /usr/local/bin/pip3.13 \
      /usr/local/lib/python3.13/ensurepip \
      /usr/local/lib/python3.13/site-packages/pip \
      /usr/local/lib/python3.13/site-packages/pip-*.dist-info \
      /usr/sbin/dpkg* \
      /usr/share/bug/dpkg \
      /var/cache/apt \
      /var/lib/apt

USER 10001:10001
EXPOSE 8080 8081
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["python", "-m", "runtime.healthcheck", "--path", "/readyz"]
ENTRYPOINT ["python", "-m", "runtime.service"]
CMD ["core"]
