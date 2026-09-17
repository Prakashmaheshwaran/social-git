import { REDDIT_CAPABILITIES } from "@social-git/reddit-adapter";
import { X_CAPABILITIES, X_TRANSPORT_ADMISSION } from "@social-git/x-adapter";
import { OPERATIONS } from "../src/contract.ts";
import { REDDIT_UNSUPPORTED_CAPABILITIES } from "../src/reddit-adapter.ts";

const redditPublicOperation: Readonly<Record<string, string>> = Object.freeze({
  "profile.get": "reads.profile", "subreddit.get": "reads.subreddit", "listing.list": "reads.feed",
  "post.get": "reads.post", "comments.list": "reads.comments", "search.query": "reads.search",
  "user.get": "reads.userProfile", "user.content": "reads.userContent", "account.saved": "reads.saved",
  "account.upvoted": "reads.upvoted", "post.createText": "actions.create", "post.createLink": "actions.create",
  "post.createMedia": "actions.create", "comment.create": "actions.create", "reply.create": "actions.create",
  "item.editOwn": "actions.create", "vote.set": "actions.create", "save.set": "actions.create",
  "save.unset": "actions.create", "subreddit.subscribe": "actions.create", "subreddit.unsubscribe": "actions.create",
  "item.deleteOwn": "actions.create",
  "message.inbox": "reddit.messages.list", "message.thread": "reddit.messages.thread",
  "message.send": "reddit.messages.actions.create", "message.reply": "reddit.messages.actions.create",
});

const xPublicOperation: Readonly<Record<string, string>> = Object.freeze({
  "account.identity": "x.account.health", "profile.get": "x.profiles.get", "post.get": "x.posts.get",
  "thread.get": "x.threads.get", "timeline.home": "x.timelines.home", "timeline.user": "x.timelines.user",
  "search.query": "x.search", "notifications.list": "x.notifications.list", "conversations.list": "x.conversations.list",
  "bookmarks.list": "x.bookmarks.list", "post.create": "x.actions.create", "post.reply": "x.actions.create",
  "followers.list": "x.followers.list", "following.list": "x.following.list", "lists.lookup": "x.lists.lookup",
  "lists.memberships": "x.lists.memberships", "lists.members": "x.lists.members", "lists.timeline": "x.lists.timeline",
  "post.delete": "x.actions.create", "post.like.set": "x.actions.create", "post.repost.set": "x.actions.create",
  "profile.follow.set": "x.actions.create", "bookmark.set": "x.actions.create", "post.media.create": "x.actions.create",
  "message.send": "x.actions.create",
});

export function capabilityMappingErrors() {
  const operationIds = new Set(OPERATIONS.map(({ operationId }) => operationId));
  const errors: string[] = [];
  for (const capability of REDDIT_CAPABILITIES) {
    const publicOperation = redditPublicOperation[capability.operation];
    if (!publicOperation) errors.push(`Reddit capability ${capability.operation} has no public operation mapping`);
    else if (!operationIds.has(publicOperation)) errors.push(`Reddit capability ${capability.operation} maps to missing ${publicOperation}`);
  }
  for (const capability of X_CAPABILITIES) {
    const publicOperation = xPublicOperation[capability.operation];
    if (!publicOperation) errors.push(`X capability ${capability.operation} has no public operation mapping`);
    else if (!operationIds.has(publicOperation)) errors.push(`X capability ${capability.operation} maps to missing ${publicOperation}`);
  }
  for (const operation of Object.keys(redditPublicOperation)) if (!REDDIT_CAPABILITIES.some((item) => item.operation === operation)) errors.push(`Stale Reddit capability mapping ${operation}`);
  for (const operation of Object.keys(xPublicOperation)) if (!X_CAPABILITIES.some((item) => item.operation === operation)) errors.push(`Stale X capability mapping ${operation}`);
  return errors;
}

export function generateCapabilityMatrix() {
  const redditRows = REDDIT_CAPABILITIES.map((capability) => `| \`${capability.operation}\` | ${capability.mode} | \`${redditPublicOperation[capability.operation]}\` | ${capability.fixtureEnabled ? "yes" : "no"} | ${capability.productionEnabled ? "enabled" : "disabled"} | ${capability.disabledReason ?? "—"} |`).join("\n");
  const xRows = X_CAPABILITIES.map((capability) => `| \`${capability.operation}\` | ${capability.mode} | \`${xPublicOperation[capability.operation]}\` | ${capability.fixtureEnabled ? "yes" : "no"} | ${capability.productionEnabled ? "enabled" : "disabled"} | ${capability.disabledReasons.join(", ")} |`).join("\n");
  const unsupportedRows = Object.entries(REDDIT_UNSUPPORTED_CAPABILITIES).map(([capability, reason]) => `| Reddit | \`${capability}\` | unsupported | \`${reason}\` |`).join("\n");
  return `# Product-reset capability matrix

Document version: 1.0.0
Generated: do not hand edit; run \`npm run generate:product-docs\`.

This matrix is generated from \`src/contract.ts\`, \`packages/reddit-adapter/src/contract.mjs\`,
\`packages/x-adapter/src/contract.mjs\`, \`packages/x-adapter/src/admission.mjs\`, and
\`src/reddit-adapter.ts\`. “Implemented” means the deterministic and runtime
boundary exists. It does not substitute for separately authorized live acceptance.

## Reddit

Reddit capabilities marked enabled are admitted for production direct-session
dispatch. Messaging rows are fixture-only candidates and remain disabled for
the explicit evidence reasons shown. Every admitted operation still stops on
identity mismatch, challenge, checkpoint, CAPTCHA, revocation, rate limit, or
protocol drift.

| Adapter capability | Mode | Public OpenAPI operation | Fixture | Production | Disabled reason |
| --- | --- | --- | --- | --- | --- |
${redditRows}

## X

All X contracts are fixture-only. Production dispatch is fail-closed until the
machine-readable admission gates below pass:

${X_TRANSPORT_ADMISSION.disabledReasons.map((reason) => `- \`${reason}\``).join("\n")}

| Adapter capability | Mode | Public OpenAPI operation | Fixture | Production | Live gate status |
| --- | --- | --- | --- | --- | --- |
${xRows}

## Explicitly unsupported

Unsupported capabilities have no write/read endpoint and must never be emulated.

| Platform | Capability | Status | Reason |
| --- | --- | --- | --- |
${unsupportedRows}
| X | production transport | fixture-only | ${X_TRANSPORT_ADMISSION.disabledReasons.map((reason) => `\`${reason}\``).join("; ")} |
`;
}
