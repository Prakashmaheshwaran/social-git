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
  the trusted core broker. `createRedditRouteAuthority` seals the target to the
  exact reviewed Reddit host set. `createPinnedHttpsConnector` dials one public
  DNS answer directly with SNI and does not read proxy environment variables.
  DNS, connection, headers, streamed body reads, and redirects share one
  aborting deadline. Response bytes are counted before concatenation.
- Core and workers exchange version 1 JSON payloads over a four-byte
  length-prefixed stdio transport. The declared size is rejected before payload
  allocation or JSON parsing. Decoding then enforces UTF-8, type, depth,
  collection, entry, and string bounds. Envelopes reject unknown fields and
  bind the launched child peer, request, action, tenant, account, server route,
  generation, capability, deadline, and ordered event/terminal sequences.
- `PlatformStopCircuit` opens a platform-wide circuit on challenge, checkpoint,
  CAPTCHA, rate limit, identity mismatch, revocation, or protocol drift. A
  different account or route cannot bypass it. Recovery requires a verified
  authorization record and persists the new minimum generation, so queued work
  from an older generation stays fenced.
- Platform JSON is bounded before parse, projected through a strict schema,
  cloned, frozen, and rejected if the normalized output contains active HTML or
  an unadmitted Reddit canonical URL.

`forkIsolatedWorker` requires Node.js 26 or newer. It applies the stable Node
permission model, a positive environment allowlist, and bounded stdio. On
Darwin it also launches through the kernel `sandbox-exec` profile that denies
network and filesystem writes. The child asserts its effective permissions
before it accepts a request, and the parent validates its live startup
attestation. The exported `WORKER_SANDBOX_POLICY` separates these enforced
local layers from the mandatory production-container admission requirements:
distinct non-root identity, read-only root, zero capabilities,
no-new-privileges, no database/key/control-plane mounts or sockets, bounded
process/file/memory/CPU resources, and network namespace `none`. Production
capabilities remain disabled until that external runtime is present and
inspected.

## Security evidence

| Control or threat | Executable evidence |
| --- | --- |
| SG-SEC-007, TM-04 | `test/ipc.test.mjs` covers pre-allocation length framing, byte/depth/Unicode bounds, strict outcomes, peer and binding mismatch, duplicates, ordered events, and late fencing. `packages/reddit-adapter/test/adapter.test.mjs` proves the live fixture path uses the codec and rejects unknown result fields. |
| SG-SEC-008, TM-04, TM-06 | `test/egress.test.mjs` covers sealed Reddit routes, complete public address policy including RFC 6052 translation addresses, direct pinned dialing, DNS/redirect changes, proxy environment exclusion, aborting deadlines, and streamed response limits. `test/runtime.test.mjs` proves an actual launched child cannot read SQLite or key canaries, cannot use network/write permission, and cannot see control-plane/proxy inputs. |
| SG-SEC-009, TM-10 | `test/stop-and-response.test.mjs` covers every mandatory stop, verified recovery, and stale-generation fencing. The Reddit adapter integration test proves a stop cannot be bypassed by rotating the account. |
| SG-SEC-010, TM-09 | `test/stop-and-response.test.mjs` covers hostile sizes/depth/Unicode, strict projection, canonical URLs, inert output, immutability, and library-object exclusion. |

Run the deterministic suite:

```sh
npm test
```

The deterministic Reddit fixture consumes the runtime, framed IPC, strict
schema, and stop-circuit primitives. Its worker has no network access.
Production reads and writes remain disabled until a separately reviewed
container runtime and real core egress connector consume the same boundary. No
browser automation or official social API is used.
