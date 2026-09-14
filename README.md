# Social Git

Social Git is a self-hosted, library-backed gateway for managing multiple social accounts through owner-authorized web sessions.

The Reddit-first MVP will expose a stable REST API for account/session management, reads, and explicitly authorized interactions. Platform adapters use pinned protocol libraries; the production runtime does not use browser automation or official social-network APIs.

Status: project bootstrap and dependency admission research.

The library-independent Reddit boundary and deterministic child-process fixture live in
`packages/reddit-adapter`. Run its suite with `npm test` from that directory.

The deny-by-default IPC, worker sandbox, fixed-egress broker, hostile-response,
and stop-circuit primitives live in `packages/worker-security`. Its deterministic
adversarial suite also runs with `npm test` from that directory.
