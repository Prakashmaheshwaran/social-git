export const X_PROTOCOL_VERSION = 1;
export const X_MAX_RESPONSE_BYTES = 1024 * 1024;
export const X_MAX_PAGE_ITEMS = 100;
export const X_MAX_CURSOR_BYTES = 512;

const definitions = [
  ["account.identity", "Account identity and health"],
  ["profile.get", "Profile lookup"],
  ["post.get", "Post lookup"],
  ["thread.get", "Thread lookup"],
  ["timeline.home", "Home timeline"],
  ["timeline.user", "User timeline"],
  ["search.query", "Post search"],
  ["notifications.list", "Account notifications"],
  ["conversations.list", "Conversation summaries"],
  ["bookmarks.list", "Account bookmarks"]
];

export const X_CAPABILITIES = Object.freeze(definitions.map(([operation, summary]) => Object.freeze({
  operation,
  summary,
  mode: "read",
  authorizationScope: `x.read.${operation}`,
  fixtureEnabled: true,
  productionEnabled: false,
  status: "fixture_only",
  disabledReason: "No browserless direct-HTTP transport has passed production admission."
})));

export class XContractError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "XContractError";
    this.code = code;
    this.rateLimit = options.rateLimit;
  }
}

export function capabilityFor(operation) {
  return X_CAPABILITIES.find((capability) => capability.operation === operation) ?? null;
}

export function assertFixtureOperation(operation) {
  const capability = capabilityFor(operation);
  if (!capability) throw new XContractError("UNKNOWN_OPERATION", "The X operation is not supported.");
  return capability;
}
