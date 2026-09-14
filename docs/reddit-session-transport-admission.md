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

The comment-ownership lookup and media protocol shapes use a second, supporting
source review: PRAW `8.0.3` at commit
`fdc29bb103ad652eea6740c77c2be099d1c1357e`, released on 2026-08-12 under
BSD-2-Clause. The review pins the Git blobs and SHA-256 digests for
`praw/endpoints.py`, `praw/models/media.py`,
`praw/models/reddit/subreddit/subreddit.py`, and `praw/reddit.py` in
`packages/reddit-adapter/src/protocol-corpus.mjs`. PRAW is protocol evidence
only. It is not installed, imported, linked, or used for OAuth, transport,
session storage, retries, or runtime behavior. This supporting evidence does
not weaken or replace the primary `reddit-lyr` source-corpus admission.

## Boundary and failure decision

Core installs one connector closure for one tenant, account, route, and session
generation. The closure owns the cookie map and CSRF/modhash value. Those
values never enter an operation input, route descriptor, worker result, error,
diagnostic, or normalized response. The protocol transport receives an opaque
server-issued route lease only.

The fixed-egress authority admits HTTPS to `www.reddit.com` for session
requests. The media path separately admits only HTTPS to
`reddit-uploaded-media.s3-accelerate.amazonaws.com` for a server-issued upload
lease and WSS to `wss.redditmedia.com` for bounded post-processing evidence.
Each authority resolves and validates public addresses, pins the selected
address for TLS, uses the expected hostname for SNI, rejects authority changes
and redirects, shares an aborting deadline, bounds streamed data, and ignores
proxy environment variables. Reddit cookies and CSRF values are excluded from
the S3 and WSS connectors. The trusted connectors reject `Host`, proxy,
hop-by-hop, content-length, and other header overrides.

Reads and writes use no internal retry loop. A write calls the connector once.
A disconnect, timeout, 5xx, or malformed success after that call is an
unverified `UNKNOWN` result and remains cached under the caller-scoped
idempotency key. Reconciliation is read-only and returns `pending` when the
admitted corpus cannot prove the native result; it never repeats the write.
Authenticated challenge, checkpoint, CAPTCHA, rate limit, revocation, wrong
identity, and protocol drift states open the shared Reddit stop circuit.

## Capability decision

The production path enables profile, subreddit, listing, post, comments, and
search reads. It enables text, link, and image media posts, comments, replies,
votes, save, unsave, and caller-owned post or comment deletion. Delete first
normalizes the target fullname, performs an admitted bounded author read, and
compares that author with the already validated expected identity. A missing,
foreign, malformed, or unverifiable author is denied before submission.

Media input accepts only a caller- and account-bound `core-media:` reference.
Core validates an image of at most 8 MiB, stores its digest, and durably records
the phases `reserved`, `leased`, `uploaded`, `submitting`, `submitted`, and
`processed`. A bounded worker lease is opaque to Core; signed upload fields stay
inside the isolated worker. Lease and upload failures are pre-submit failures.
Core atomically records `submitting` before the single submit call. Any timeout,
disconnect, crash, malformed response, or processing failure after that point
is `UNKNOWN` and cannot be retried automatically. Confirmed completion requires
a native post ID and canonical Reddit URL.

The media capability is declared only when the Core phased worker provider is
configured. A direct session transport without that boundary continues to
report `CORE_MEDIA_PHASE_TRANSPORT_REQUIRED` and refuses media before dispatch.

## Supply-chain disposition

The source-level transport, supporting protocol evidence, and deterministic
test paths are admitted. The
current reproducible production image is a Python-only runtime shell and does
not contain the pinned Node.js runtime. Deployment is therefore blocked until
the executable gateway image includes Node.js `26.3.1` and an independent
AMD64/ARM64 attestation records its complete installed runtime closure, source,
licenses, hashes, and browser/official-client exclusion. No live Reddit session
or request was used for this decision.
