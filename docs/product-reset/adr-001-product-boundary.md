# ADR-001: self-hosted direct-session product boundary

Document version: 1.0.0
Status: accepted.

## Context

Social Git must be deployable like a normal self-hosted application while
providing a stable API over owner-authorized social sessions. A browser runtime
is expensive, difficult to isolate, and unsuitable as the service protocol.
Official social APIs do not provide the target parity or operating model.
Private web protocols drift, and writes can become ambiguous after dispatch.

## Decision

- Core owns tenant identity, encrypted session and network-route custody,
  expected native identity, policy, idempotency, actions, audit, webhooks,
  backups, and public contracts.
- Platform adapters use standard direct HTTP in isolated workers and normalize
  bounded results. They never expose raw upstream bodies or library objects.
- The committed OpenAPI contract, local explorer, MCP tools, and product matrix
  are generated or validated against shared operation/capability sources.
- Reddit mappings marked production-enabled by the adapter registry are the
  first release surface. Explicit exclusions remain visible by reason code.
- X remains fixture-only. Its candidate transport and public-asset evidence are
  useful engineering inputs, but no runtime dispatch occurs until all
  machine-readable gates and authorized live proofs pass.
- A write is single-attempt. Once submission may have started, loss of proof is
  UNKNOWN. Recovery is read-only reconciliation and never automatic resubmit.
- The product ships all UI/API documentation assets locally under the same CSP;
  runtime operation does not depend on a CDN or hosted service.

## Consequences

The architecture is more explicit than a generic browser agent and requires
ongoing protocol admission work. In return, account isolation, repeatability,
operational cost, failure semantics, and API stability are testable. Capability
truth is intentionally conservative: unsupported or unproven work appears as a
machine-readable boundary rather than a best-effort success.

## Rejected alternatives

- Browser automation as the integration runtime.
- Official platform APIs as the primary transport.
- Importing a third-party client wholesale without exact source/license review.
- Retrying writes after timeouts or rotating through accounts/proxies.
- Hosted Swagger/Redoc assets that make a self-hosted release depend on a CDN.
