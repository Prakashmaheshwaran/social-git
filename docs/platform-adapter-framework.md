# Platform Adapter Framework

This document defines the framework for adding new social platform adapters to Social Git.

## Adapter Contract

Every platform adapter must implement the following components:

### 1. Package Structure

```
packages/<platform>-adapter/
├── package.json
├── src/
│   ├── index.mjs           # Public exports
│   ├── contract.mjs        # Capability definitions
│   ├── admission.mjs       # Admission gates (for production)
│   ├── protocol-corpus.mjs # Protocol evidence (if applicable)
│   ├── normalizer.mjs      # Response normalization
│   └── transport.mjs       # Platform-specific transport
├── test/
│   └── *.test.mjs          # Deterministic tests
├── THIRD_PARTY_NOTICES.md  # License notices
└── README.md              # Adapter documentation
```

### 2. Contract Definition

Define all platform capabilities in `contract.mjs`:

```javascript
export const CAPABILITIES = {
  // Read operations
  "profile.get": { mode: "read", fixture: true, production: false },
  "post.get": { mode: "read", fixture: true, production: false },
  
  // Write operations
  "post.create": { mode: "write", fixture: true, production: false },
  "comment.create": { mode: "write", fixture: true, production: false },
  
  // Disabled capabilities
  "unsupported.feature": { mode: "read", fixture: false, production: false, reason: "UNSUPPORTED_REASON" }
};
```

### 3. Admission Gates

Define production admission gates in `admission.mjs`:

```javascript
export const ADMISSION = {
  productionEnabled: false,
  disabledReasons: [
    "ENDPOINT_CURRENTNESS_UNPROVEN",
    "AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING",
    "AUTHORIZED_LIVE_READ_PROOF_MISSING",
    "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"
  ]
};
```

### 4. Transport Requirements

- Use standard HTTP/HTTPS (no browser automation)
- Fixed egress to known platform hosts
- No official platform APIs as primary transport
- Session material encrypted at rest in Core custody
- Worker isolation (no database access)

### 5. Normalization

- Return bounded DTOs only
- Never expose raw library objects
- Include native IDs and canonical URLs when available
- Redact secret-like values
- Normalize errors to standard stop states

### 6. Testing

Every adapter must have deterministic tests:

- Capability matrix verification
- Protocol corpus parsing (if applicable)
- Normalization of all supported operations
- Secret redaction verification
- Worker boundary tests
- Fixture-only production-disabled state verification

## Admission Checklist

Before a platform adapter can be admitted to production:

### Source and License Review

- [ ] Source code reviewed for security issues
- [ ] License compatibility verified (MIT, BSD-2-Clause, or similar)
- [ ] No copyleft licenses that would affect project license
- [ ] Third-party notices documented in THIRD_PARTY_NOTICES.md
- [ ] Source committed to repository with exact Git blob hashes

### Protocol Corpus Review

- [ ] Protocol evidence extracted and documented
- [ ] Endpoint mappings verified
- [ ] Request/response shapes understood
- [ ] Authentication mechanism documented
- [ ] Rate limiting behavior documented

### Capability Definition

- [ ] All read operations defined with fixture support
- [ ] All write operations defined with fixture support
- [ ] Unsupported capabilities explicitly marked
- [ ] Disabled capabilities have clear reasons
- [ ] Capability matrix generated from contract

### Deterministic Tests

- [ ] All operations have fixture tests
- [ ] Secret redaction verified
- [ ] Worker isolation verified
- [ ] Error normalization verified
- [ ] Idempotency verified for writes
- [ ] Crash-after-submit behavior verified

### Supply Chain Review

- [ ] No browser dependencies in final image
- [ ] No official platform API dependencies
- [ ] All dependencies pinned to exact versions
- [ ] SBOM generated and reviewed
- [ ] Runtime-dependency-review.json updated

### Live Proof (Separate QA Gate)

- [ ] Authorized live identity proof obtained
- [ ] Live read operations verified
- [ ] Live write operations verified (separate approval)
- [ ] Challenge/rate limit behavior verified
- [ ] Protocol drift detection verified

## Protocol Corpus Requirements

When extracting protocol evidence:

1. **Source Attribution**: Document exact Git commit, branch, and author
2. **License Evidence**: Copy license text and verify compatibility
3. **Bloom Extraction**: Extract only needed protocol code, not entire library
4. **Version Pinning**: Pin to exact commit, not semantic version
5. **Evidence Hash**: Record SHA-256 of all extracted blobs

## Transport Requirements

All platform transports must:

1. **Fixed Egress**: DNS-pin to known platform hosts
2. **No Proxy**: Reject proxy environment variables
3. **No Redirects**: Reject or strictly validate redirects
4. **Private DNS**: Reject private/metadata addresses
5. **Timeout**: Implement bounded deadlines
6. **Size Limits**: Bound streamed data
7. **No Replay**: Detect and reject replay attacks

## Worker Isolation

Platform workers must:

1. **No Database Access**: Core-only SQLite databases
2. **Bounded IPC**: Versioned, size-bounded messages
3. **No Secret Custody**: Session material in Core only
4. **Separate UID**: Different UID from Core
5. **Separate Network**: Isolated command and egress networks
6. **Read-Only Root**: No write access to filesystem
7. **Dropped Capabilities**: All Linux capabilities dropped

## Example: Reddit Adapter

The Reddit adapter (packages/reddit-adapter/) demonstrates the complete pattern:

- **Source**: reddit-lyr 0.1.1 at commit 87ec32a
- **License**: MIT
- **Transport**: Node.js HTTPS with fixed egress
- **Capabilities**: 27 admitted operations, 4 fixture-only messaging
- **Tests**: 68 deterministic tests
- **Admission**: Admitted for production via direct-session transport

## Example: X Adapter

The X adapter (packages/x-adapter/) demonstrates the fixture-only pattern:

- **Source**: unclecode/twikit at commit 6a73ab9
- **License**: MIT
- **Transport**: Standard HTTPS with transaction header
- **Capabilities**: 25 operations, all fixture-only
- **Tests**: 16 deterministic tests
- **Admission**: Production-disabled (5 gates not passed)

## Implementation Steps

To add a new platform:

1. **Research**: Identify candidate libraries with compatible licenses
2. **Review**: Audit source code for security and protocol implementation
3. **Extract**: Extract protocol corpus (minimal, attribute fully)
4. **Implement**: Create adapter package following structure
5. **Test**: Write deterministic tests for all operations
6. **Integrate**: Add Core integration in src/<platform>-adapter.ts
7. **Document**: Add README and THIRD_PARTY_NOTICES.md
8. **Generate**: Update capability matrix
9. **Verify**: Run full test suite
10. **Admit**: Go through admission checklist (live proof separate)

## Constraints

- **No Browser Automation**: No Playwright, Selenium, Chromium, CDP
- **No Official APIs**: Primary transport must be direct session
- **No Live Credentials**: Development cannot use live social credentials
- **No Automatic Retry**: Writes are single-attempt, UNKNOWN requires manual reconciliation
- **Deterministic Only**: This framework describes deterministic implementation; live proof is separate QA gate
