const CANDIDATE_OPERATIONS = Object.freeze([
  "message.inbox",
  "message.thread",
  "message.send",
  "message.reply"
]);
const operationSet = new Set(CANDIDATE_OPERATIONS);
const testAdmissionBrand = Symbol("social-git.reddit.messaging-test-admission");

/**
 * Creates a process-local capability token for deterministic tests. Production
 * composition never calls this factory and no environment/configuration value
 * can manufacture the private brand.
 */
export function createRedditMessagingCandidateTestAdmission({ operations = CANDIDATE_OPERATIONS } = {}) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > CANDIDATE_OPERATIONS.length
    || new Set(operations).size !== operations.length || operations.some((operation) => !operationSet.has(operation))) {
    throw new TypeError("Messaging candidate test admission operations are invalid");
  }
  const admitted = new Set(operations);
  return Object.freeze({
    kind: "reddit_messaging_candidate_test_admission",
    operations: Object.freeze([...operations]),
    allows(operation) { return admitted.has(operation); },
    [testAdmissionBrand]: true
  });
}

export function isRedditMessagingCandidateAdmitted(admission, operation) {
  return admission?.[testAdmissionBrand] === true
    && operationSet.has(operation)
    && admission.allows(operation) === true;
}

export const REDDIT_MESSAGING_CANDIDATE_OPERATIONS = CANDIDATE_OPERATIONS;
