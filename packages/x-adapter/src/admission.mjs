const gates = Object.freeze({
  immutableSourceRevision: true,
  mitNoticeRecorded: true,
  noRuntimeDependency: true,
  standardDirectHttpOnly: true,
  boundedSyntheticCorpus: true,
  coreSessionCustody: true,
  isolatedWorkerBoundary: true,
  pureClientTransactionGenerator: true,
  exactEndpointCurrentness: false,
  clientTransactionHeaderProven: false,
  authorizedLiveIdentityProof: false,
  authorizedLiveReadProof: false,
  authorizedLiveWriteProof: false,
});

const reasonByGate = Object.freeze({
  exactEndpointCurrentness: "ENDPOINT_CURRENTNESS_UNPROVEN",
  clientTransactionHeaderProven: "CLIENT_TRANSACTION_HEADER_UNPROVEN",
  authorizedLiveIdentityProof: "AUTHORIZED_LIVE_IDENTITY_PROOF_MISSING",
  authorizedLiveReadProof: "AUTHORIZED_LIVE_READ_PROOF_MISSING",
  authorizedLiveWriteProof: "AUTHORIZED_LIVE_WRITE_PROOF_MISSING",
});

export const X_TRANSPORT_ADMISSION = Object.freeze({
  schema: "social-git.x-transport-admission/v1",
  sourceRevision: "6a73ab97f4de09f79139f6308c9fb80029a9f5f7",
  sourceRole: "source_corpus_only",
  runtimeDependency: false,
  candidateBoundaryImplemented: true,
  productionEnabled: false,
  gates,
  disabledReasons: Object.freeze(Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => reasonByGate[name] ?? `GATE_FAILED:${name}`)),
});

export function evaluateXTransportAdmission(requested = false) {
  return Object.freeze({
    ...X_TRANSPORT_ADMISSION,
    requested: requested === true,
    enabled: requested === true && X_TRANSPORT_ADMISSION.productionEnabled,
  });
}
