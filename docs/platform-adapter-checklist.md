# Platform Adapter Admission Checklist

Use this checklist when adding a new platform adapter to Social Git.

## Phase 1: Research and Evaluation

### Library Evaluation
- [ ] Identify candidate libraries for the platform
- [ ] Evaluate license compatibility (MIT, BSD-2-Clause, or similar)
- [ ] Review source code for security issues
- [ ] Verify no copyleft licenses that would affect project
- [ ] Check for browser automation dependencies
- [ ] Check for official platform API dependencies
- [ ] Assess maintenance status and community activity
- [ ] Document alternative libraries considered and rejected

### Protocol Understanding
- [ ] Understand platform authentication mechanism
- [ ] Document session handling requirements
- [ ] Document rate limiting behavior
- [ ] Identify all read operations to support
- [ ] Identify all write operations to support
- [ ] Identify explicitly unsupported features
- [ ] Document challenge/CAPTCHA behavior
- [ ] Document revocation detection

## Phase 2: Source and License Review

### Source Attribution
- [ ] Record exact Git commit for all source
- [ ] Record branch name and author
- [ ] Clone repository locally for review
- [ ] Extract minimal protocol corpus only
- [ ] Record SHA-256 of all extracted blobs
- [ ] Do not vend entire library into repo

### License Documentation
- [ ] Copy full license text to THIRD_PARTY_NOTICES.md
- [ ] Verify license allows modification and redistribution
- [ ] Verify license allows commercial use
- [ ] Document any attribution requirements
- [ ] Verify no copyleft传染 (GPL, AGPL, etc.)

## Phase 3: Implementation

### Package Structure
- [ ] Create packages/<platform>-adapter/ directory
- [ ] Create package.json with correct exports
- [ ] Set Node.js engine to 26.9.0
- [ ] Add to root workspaces if needed
- [ ] Create src/ directory structure
- [ ] Create test/ directory

### Contract Definition
- [ ] Create contract.mjs with CAPABILITIES export
- [ ] Define all read operations with fixture: true
- [ ] Define all write operations with fixture: true
- [ ] Mark unsupported capabilities as fixture: false
- [ ] Add disabled reasons for production-disabled operations
- [ ] Include mode (read/write) for each capability

### Admission Gates
- [ ] Create admission.mjs with ADMISSION export
- [ ] Set productionEnabled: false initially
- [ ] Define all required admission gates
- [ ] Document exact evidence required for each gate
- [ ] Set disabledReasons array
- [ ] Verify fixture mode can bypass gates for testing

### Transport Implementation
- [ ] Implement transport.mjs with standard HTTP/HTTPS
- [ ] Add fixed egress to known platform hosts
- [ ] Implement DNS pinning
- [ ] Reject proxy environment variables
- [ ] Implement redirect validation or rejection
- [ ] Add bounded deadlines
- [ ] Add size limits for streamed data
- [ ] Implement replay detection

### Normalization
- [ ] Implement normalizer.mjs for response DTOs
- [ ] Return bounded, type-safe objects only
- [ ] Never expose raw library objects
- [ ] Include native IDs when available
- [ ] Include canonical URLs when available
- [ ] Redact secret-like values
- [ ] Normalize errors to standard stop states
- [ ] Handle all platform error codes

### Core Integration
- [ ] Create src/<platform>-adapter.ts
- [ ] Implement ProductionPlatformAdapter
- [ ] Add to src/adapter.ts platform registry
- [ ] Add contract operations to src/contract.ts
- [ ] Implement worker main in src/<platform>-worker-main.ts
- [ ] Add worker HTTP handler in src/<platform>-worker-http.ts
- [ ] Add Compose service for worker
- [ ] Add worker to service.ts startup

## Phase 4: Testing

### Deterministic Tests
- [ ] Write capability matrix verification test
- [ ] Write protocol corpus parsing tests (if applicable)
- [ ] Write normalization tests for all read operations
- [ ] Write normalization tests for all write operations
- [ ] Write secret redaction verification test
- [ ] Write worker boundary test
- [ ] Write IPC message test
- [ ] Write egress validation test
- [ ] Write fixture-only production-disabled test
- [ ] Write idempotency test for writes
- [ ] Write crash-after-submit test
- [ ] Write UNKNOWN recovery test

### Test Coverage
- [ ] All read operations have fixture tests
- [ ] All write operations have fixture tests
- [ ] Error paths tested
- [ ] Edge cases tested
- [ ] No live credentials in tests
- [ ] No live platform calls in tests

### Test Execution
- [ ] Run `npm test --prefix packages/<platform>-adapter`
- [ ] All tests pass
- [ ] Run full test suite with `npm test`
- [ ] No regressions in other packages
- [ ] Run typecheck with `npm run typecheck`
- [ ] No TypeScript errors

## Phase 5: Documentation

### Package Documentation
- [ ] Create README.md in adapter package
- [ ] Document source attribution
- [ ] Document license
- [ ] Document supported operations
- [ ] Document unsupported operations
- [ ] Document protocol requirements
- [ ] Document egress requirements
- [ ] Add usage examples

### Product Documentation
- [ ] Update docs/product-reset/capability-matrix.md
- [ ] Run `npm run generate:product-docs`
- [ ] Verify matrix is auto-generated
- [ ] Update docs/api-contract.md if needed
- [ ] Update README.md if platform is user-facing

### License Notices
- [ ] Create THIRD_PARTY_NOTICES.md
- [ ] Include full license text
- [ ] Include attribution
- [ ] Include source commit
- [ ] Verify notice is copied to runtime image

## Phase 6: Supply Chain Review

### Dependency Review
- [ ] No browser dependencies
- [ ] No official platform API dependencies
- [ ] All dependencies pinned to exact versions
- [ ] No unpinned dependencies
- [ ] No unnecessary dependencies
- [ ] Review all transitive dependencies

### Image Review
- [ ] Build Docker image
- [ ] Generate SBOM
- [ ] Verify no browser components in SBOM
- [ ] Verify no official API clients in SBOM
- [ ] Verify adapter source is in image
- [ ] Verify THIRD_PARTY_NOTICES.md is in image
- [ ] Update security/runtime-dependency-review.json
- [ ] Run Python security tests in tests/

### Reproducibility
- [ ] Build image twice from same source
- [ ] Verify digests match
- [ ] Run reproducibility guard
- [ ] Verify SBOMs match
- [ ] Verify source manifests match

## Phase 7: Core Integration Verification

### Service Integration
- [ ] Verify worker starts correctly
- [ ] Verify worker health check works
- [ ] Verify Core can reach worker
- [ ] Verify command dispatch works
- [ ] Verify result ingestion works
- [ ] Verify worker isolation (no DB access)
- [ ] Verify egress isolation (separate network)

### Contract Integration
- [ ] Run `npm run generate:openapi`
- [ ] Verify OpenAPI includes platform operations
- [ ] Run `npm run validate:openapi`
- [ ] Verify validation passes
- [ ] Verify MCP tools generated
- [ ] Verify capability matrix updated

### End-to-End Tests
- [ ] Run API tests for platform
- [ ] Run fixture tests for platform
- [ ] Verify action lifecycle works
- [ ] Verify idempotency works
- [ ] Verify UNKNOWN handling works
- [ ] Verify web UI shows platform
- [ ] Verify X platform doesn't interfere

## Phase 8: Admission Gates (Deterministic)

### Endpoint Currentness
- [ ] Document how endpoint evidence was obtained
- [ ] Record public asset hashes
- [ ] Record GraphQL operation IDs (if applicable)
- [ ] Document any protocol changes detected
- [ ] Set ENDPOINT_CURRENTNESS gate based on evidence

### Client Transaction Header
- [ ] Implement any required transaction header
- [ ] Test with current platform assets
- [ ] Verify header format matches platform expectations
- [ ] Set CLIENT_TRANSACTION_HEADER gate based on tests

### Fixture-Only Verification
- [ ] Verify all operations work in fixture mode
- [ ] Verify production is disabled by default
- [ ] Verify admission gates are enforced
- [ ] Verify worker returns NOT_ADMITTED when gates fail
- [ ] Verify fixture mode can bypass gates

## Phase 9: Live Proof (Separate QA Gate)

**Note**: This phase requires separate QA authorization and dedicated test accounts. It is NOT part of the development implementation.

### Identity Proof
- [ ] Authorized QA obtains dedicated test account
- [ ] Expected native identity documented
- [ ] Session material obtained through external bootstrap
- [ ] Session material imported to Social Git
- [ ] Identity verification succeeds
- [ ] Evidence recorded and reviewed

### Read Proof
- [ ] Authorized QA performs bounded read operations
- [ ] Profile read succeeds with native ID
- [ ] Listing read succeeds with canonical URLs
- [ ] Pagination works correctly
- [ ] Rate limit behavior verified
- [ ] Challenge behavior verified
- [ ] Evidence recorded and reviewed

### Write Proof (Separate Approval)
- [ ] Separate approval for write operations
- [ ] Bounded write operations performed
- [ ] Write succeeds with native ID
- [ ] Write succeeds with canonical URL
- [ ] Idempotency verified
- [ ] Crash-after-submit verified
- [ ] Reconciliation verified
- [ ] Evidence recorded and reviewed

### Admission Decision
- [ ] All live evidence reviewed
- [ ] Independent QA records GO/NO-GO
- [ ] Admission gates updated to true
- [ ] productionEnabled set to true
- [ ] disabledReasons cleared
- [ ** ] Live proof never substitutes for deterministic evidence

## Phase 10: Release Preparation

### Final Verification
- [ ] Run `npm run verify`
- [ ] All checks pass
- [ ] Run deterministic acceptance harness
- [ ] All scenarios pass
- [ ] Build release images
- [ ] Verify reproducibility
- [ ] Generate SBOMs
- [ ] Verify SBOMs match review

### Release Notes
- [ ] Document platform addition
- [ ] Document supported operations
- [ ] Document admission evidence
- [ ] Document known limitations
- [ ] Update CHANGELOG
- [ ] Tag release commit

## Post-Release

### Monitoring
- [ ] Monitor for protocol drift
- [ ] Monitor for rate limit changes
- [ ] Monitor for auth changes
- [ ] Update admission gates if needed
- [ ] Refresh endpoint evidence periodically

### Maintenance
- [ ] Keep protocol corpus current
- [ ] Update library if new version has security fixes
- [ ] Re-run admission process after major changes
- [ ] Document any protocol changes discovered
