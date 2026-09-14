export const READ_OPERATIONS = Object.freeze([
  "read.account-profile",
  "read.subreddit-metadata",
  "read.feed",
  "read.post",
  "read.comments",
  "read.search",
]);

export const WRITE_OPERATIONS = Object.freeze([
  "write.post.text",
  "write.post.link",
  "write.post.media",
  "write.comment",
  "write.reply",
  "write.vote",
  "write.save",
  "write.unsave",
  "write.delete",
]);

export const PLATFORM_FAILURES = Object.freeze([
  ["rate_limit", 429, "RATE_LIMITED"],
  ["challenge", 423, "CHALLENGE_REQUIRED"],
  ["checkpoint", 423, "CHECKPOINT_REQUIRED"],
  ["captcha", 423, "CAPTCHA_REQUIRED"],
  ["protocol_drift", 502, "PROTOCOL_DRIFT"],
]);

export const REQUIRED_DRIVER_METHODS = Object.freeze([
  "reset",
  "call",
  "control",
  "inspect",
  "close",
]);

export function validateDriver(driver) {
  if (!driver || typeof driver !== "object") {
    throw new TypeError("createDriver() must return an object");
  }

  for (const method of REQUIRED_DRIVER_METHODS) {
    if (typeof driver[method] !== "function") {
      throw new TypeError(`acceptance driver is missing ${method}()`);
    }
  }

  if (!driver.metadata || typeof driver.metadata !== "object") {
    throw new TypeError("acceptance driver is missing metadata");
  }

  if (!['fixture_self_test', 'integration_candidate'].includes(driver.metadata.kind)) {
    throw new TypeError("driver metadata.kind must identify fixture_self_test or integration_candidate");
  }
}

export function candidateVerdict(metadata, scenarioResults) {
  if (metadata?.kind !== "integration_candidate") {
    return "NOT_EVALUATED";
  }

  const hasImmutableCandidate = /^(?:git:)?[a-f0-9]{40}$|^sha256:[a-f0-9]{64}$/.test(
    metadata.candidateRef ?? "",
  );
  const hasImmutableImage = /^sha256:[a-f0-9]{64}$/.test(metadata.imageDigest ?? "");

  if (!hasImmutableCandidate || !hasImmutableImage) {
    return "NO-GO";
  }

  return scenarioResults.length > 0
    && scenarioResults.every((result) => result.status === "PASS")
    ? "GO"
    : "NO-GO";
}
