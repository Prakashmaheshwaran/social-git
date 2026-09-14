# Social Git

Social Git is a self-hosted, library-backed gateway for managing multiple social accounts through owner-authorized web sessions.

The Reddit-first MVP will expose a stable REST API for account/session management, reads, and explicitly authorized interactions. Platform adapters use pinned protocol libraries; the production runtime does not use browser automation or official social-network APIs.

Status: project bootstrap and dependency admission research.

## Runtime packaging

The browser-free core/worker container contract, development and production Compose files, deterministic source metadata, backup/restore commands, and CI-ready verification scripts are documented in [docs/packaging.md](docs/packaging.md).
