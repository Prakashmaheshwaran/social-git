# Worker security boundary

This dependency-free package implements the deny-by-default boundary between
Social Git core, isolated platform workers, and the trusted egress broker. It
does not perform live social requests and does not contain route credentials.

## Integration contract

- Core provisions route records and receives opaque leases from
  `ServerRouteAuthority`. Worker and API inputs cannot provide a proxy,
  destination, host, connector, or route material. A lease is bound to tenant,
  account, route ID, and generation.
- Workers have no network permission. They send origin-relative descriptors to
  the trusted core broker. The broker selects the server-owned target and
  connector, ignores proxy environment variables, permits HTTPS to admitted
  Reddit hosts only, resolves before every connection and redirect, pins the
  connected peer to that public answer set, and bounds deadlines, redirects,
  compressed bytes, and decompressed bytes.
- Core and workers exchange version 1 JSON frames. Decoding enforces byte,
  UTF-8, type, depth, collection, entry, and string bounds. Envelopes reject
  unknown fields and bind peer, request, action, tenant, account, route,
  generation, capability, deadline, and one terminal sequence.
- `PlatformStopCircuit` opens a platform-wide circuit on challenge, checkpoint,
  CAPTCHA, rate limit, identity mismatch, revocation, or protocol drift. A
  different account or route cannot bypass it. Recovery requires an explicit
  authority, reason, and newer generation.
- Platform JSON is bounded before parse, projected through a strict schema,
  cloned, frozen, and rejected if the normalized output contains active HTML or
  an unadmitted Reddit canonical URL.

`forkIsolatedWorker` requires Node.js 26 or newer because it uses the stable
permission model to omit network, file-write, process-spawn, native-addon, and
worker-thread authority. Its environment is built from an allowlist instead of
inheriting the core environment. Production packaging must also apply the
exported `WORKER_SANDBOX_POLICY`: distinct non-root UID/GID, read-only root,
zero capabilities, no-new-privileges, no database/key/control-plane mounts or
sockets, one-process and bounded file/memory/CPU limits, and network namespace
`none`. The only outbound path is the trusted broker outside that namespace.

## Security evidence

| Control or threat | Executable evidence |
| --- | --- |
| SG-SEC-007, TM-04 | `test/ipc.test.mjs` covers strict frames, byte/depth/Unicode bounds, unknown fields, peer and binding mismatch, duplicates, and late fencing. `test/runtime.test.mjs` runs an actual permission-confined child. |
| SG-SEC-008, TM-04, TM-06 | `test/egress.test.mjs` covers server route leases, admitted hosts, public address policy, DNS pinning/rebinding, redirects, alternate schemes, environment proxies, and response limits. `test/runtime.test.mjs` proves the worker has no network/write permission and cannot read SQLite or key canaries or see control-plane/proxy variables. |
| SG-SEC-009, TM-10 | `test/stop-and-response.test.mjs` covers every mandatory stop and proves queued work cannot continue by rotating routes or accounts. |
| SG-SEC-010, TM-09 | `test/stop-and-response.test.mjs` covers hostile sizes/depth/Unicode, strict projection, canonical URLs, inert output, immutability, and library-object exclusion. |

Run the deterministic suite:

```sh
npm test
```

This package supplies the boundary primitives. The parallel core, Reddit
worker, and runtime-packaging changes must consume them before a production
release can be declared safe. No browser automation or official social API is
used.
