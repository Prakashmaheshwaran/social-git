import { X_TRANSPORT_ADMISSION } from "./admission.mjs";

export const X_PROTOCOL_VERSION = 1;
export const X_MAX_RESPONSE_BYTES = 1024 * 1024;
export const X_MAX_PAGE_ITEMS = 100;
export const X_MAX_CURSOR_BYTES = 512;

const definitions = [
  ["account.identity", "Account identity and health", "read"],
  ["profile.get", "Profile lookup", "read"],
  ["post.get", "Post lookup", "read"],
  ["thread.get", "Thread lookup", "read"],
  ["timeline.home", "Home timeline", "read"],
  ["timeline.user", "User timeline", "read"],
  ["search.query", "Post search", "read"],
  ["notifications.list", "Account notifications", "read"],
  ["conversations.list", "Conversation summaries", "read"],
  ["bookmarks.list", "Account bookmarks", "read"],
  ["followers.list", "Profile followers", "read"],
  ["following.list", "Profiles followed by a user", "read"],
  ["lists.lookup", "List lookup", "read"],
  ["lists.memberships", "Connected account list memberships", "read"],
  ["lists.members", "List members", "read"],
  ["lists.timeline", "List timeline", "read"],
  ["post.create", "Create text post", "write"],
  ["post.reply", "Reply to post", "write"],
  ["post.delete", "Delete caller-owned post", "write"],
  ["post.like.set", "Set post like state", "write"],
  ["post.repost.set", "Set post repost state", "write"],
  ["profile.follow.set", "Set profile follow state", "write"],
  ["bookmark.set", "Set post bookmark state", "write"],
  ["post.media.create", "Create media post", "write"],
  ["message.send", "Send direct message", "write"]
];

export const X_CAPABILITIES = Object.freeze(definitions.map(([operation, summary, mode]) => Object.freeze({
  operation,
  summary,
  mode,
  authorizationScope: `x.${mode}.${operation}`,
  fixtureEnabled: true,
  productionEnabled: false,
  status: "fixture_only",
  disabledReason: X_TRANSPORT_ADMISSION.disabledReasons[0],
  disabledReasons: X_TRANSPORT_ADMISSION.disabledReasons,
  transportCandidate: "unclecode/twikit@6a73ab97f4de09f79139f6308c9fb80029a9f5f7",
  admissionSchema: X_TRANSPORT_ADMISSION.schema,
})));

export class XContractError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "XContractError";
    this.code = code;
    this.rateLimit = options.rateLimit;
    this.retryable = options.retryable === true;
    this.actionRequired = options.actionRequired === true;
    this.submissionMayHaveStarted = options.submissionMayHaveStarted === true;
    this.observedNativeIdentity = options.observedNativeIdentity;
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

export function assertFixtureWriteOperation(operation) {
  const capability = assertFixtureOperation(operation);
  if (capability.mode !== "write") throw new XContractError("UNKNOWN_OPERATION", "The X write operation is not supported.");
  return capability;
}
