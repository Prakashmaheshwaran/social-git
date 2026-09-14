# Reddit session transport admission

Decision date: 2026-09-14

Status: **conditionally admitted for the library production path; final image use is blocked**

## Selected transport

The selected browser-free transport is the built-in `node:https` client from
Node.js `26.3.1`, runtime revision `v26.3.1`. The source is the Node.js release
archive at `https://nodejs.org/dist/v26.3.1/node-v26.3.1.tar.xz`, SHA-256
`979b9b8308a8d2d4a27c662ed50448c85f970c0fd4f5ce8b98e8da78c441f2bc`.
Node.js is MIT licensed and its distribution license contains the bundled
third-party notices. The reviewed local license evidence has SHA-256
`148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5`.

The repository now pins this revision in `.node-version` and in the root,
Reddit adapter, and worker-security package engine declarations. No npm runtime
package was added. The exact runtime component inventory observed through
`process.versions`, the protocol-corpus revision, and the supply-chain decision
are recorded in `security/reddit-session-transport-review.json`.
That record also captures the complete Homebrew receipt dependency list and
executable digest for the Darwin ARM64 test host. This host evidence is not used
as Linux production-image evidence.

This admission does not admit `reddit-lyr` as an installed package and does not
admit its `curl_cffi` transport. The implementation continues to use only the
attributed endpoint and normalizer corpus from `reddit-lyr` manifest `0.1.1`,
commit `87ec32aff905923ecd156e7951c168adfdf6fac1`, under its retained MIT notice.

## Boundary and failure decision

Core installs one connector closure for one tenant, account, route, and session
generation. The closure owns the cookie map and CSRF/modhash value. Those
values never enter an operation input, route descriptor, worker result, error,
diagnostic, or normalized response. The protocol transport receives an opaque
server-issued route lease only.

The fixed-egress authority admits only HTTPS to `www.reddit.com`. It resolves
and validates public addresses, pins the selected address for the TLS
connection, uses the Reddit hostname for SNI, re-resolves redirects, rejects
authority changes, shares one aborting deadline across DNS/connect/headers/body,
bounds the streamed response, and ignores proxy environment variables. The
trusted connector rejects `Host`, proxy, hop-by-hop, content-length, and other
header overrides.

Reads and writes use no internal retry loop. A write calls the connector once.
A disconnect, timeout, 5xx, or malformed success after that call is an
unverified `UNKNOWN` result and remains cached under the caller-scoped
idempotency key. Reconciliation is read-only and returns `pending` when the
admitted corpus cannot prove the native result; it never repeats the write.
Authenticated challenge, checkpoint, CAPTCHA, rate limit, revocation, wrong
identity, and protocol drift states open the shared Reddit stop circuit.

## Capability decision

The production path enables profile, subreddit, listing, post, comments, and
search reads. It enables text and link posts, comments, replies, votes, save,
unsave, and caller-owned post deletion. Delete fetches and validates the post
author against the already validated session identity before submission.

Two capabilities remain disabled:

- Media post: `MEDIA_FLOW_NOT_ADMITTED`. There is no reviewed upload lease,
  byte transfer, finalize, submit, and processing state machine.
- Caller-owned comment delete: `CAPABILITY_DISABLED`. The admitted corpus has
  no read route that can derive and validate a comment author from only a
  comment fullname. The transport refuses the operation before submission.

## Supply-chain disposition

The source-level transport and its deterministic test path are admitted. The
current reproducible production image is a Python-only runtime shell and does
not contain the pinned Node.js runtime. Deployment is therefore blocked until
the executable gateway image includes Node.js `26.3.1` and an independent
AMD64/ARM64 attestation records its complete installed runtime closure, source,
licenses, hashes, and browser/official-client exclusion. No live Reddit session
or request was used for this decision.
