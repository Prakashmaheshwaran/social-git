export function xFixture(operation, data, headers = { "x-rate-limit-limit": "50", "x-rate-limit-remaining": "49", "x-rate-limit-reset": "2000000000" }) {
  return Object.freeze({ status: 200, headers: Object.freeze({ ...headers }), body: Object.freeze({ version: 1, operation, data }) });
}

export const X_FIXTURE_ENTITIES = Object.freeze({
  account: Object.freeze({ type: "account", nativeId: "100", canonicalUrl: "https://x.com/fixture_owner", username: "fixture_owner", displayName: "Fixture Owner", description: "Synthetic account", followersCount: 12, followingCount: 4, createdAt: "2024-01-02T03:04:05.000Z", verified: false }),
  profile: Object.freeze({ type: "profile", nativeId: "200", canonicalUrl: "https://x.com/fixture_profile", username: "fixture_profile", displayName: "Fixture Profile", followersCount: 8, followingCount: 2, createdAt: "2023-02-03T04:05:06.000Z", verified: false }),
  post: Object.freeze({ type: "post", nativeId: "300", canonicalUrl: "https://x.com/fixture_owner/status/300", authorNativeId: "100", text: "Synthetic X fixture post", createdAt: "2026-09-17T00:00:00.000Z", replyCount: 1, repostCount: 2, likeCount: 3, quoteCount: 0, conversationId: "300" }),
  notification: Object.freeze({ type: "notification", nativeId: "400", notificationType: "mention", actorNativeId: "200", postNativeId: "300", text: "Synthetic mention", createdAt: "2026-09-17T00:01:00.000Z" }),
  conversation: Object.freeze({ type: "conversation", nativeId: "500", participantNativeIds: ["100", "200"], lastMessageText: "Synthetic conversation", updatedAt: "2026-09-17T00:02:00.000Z" }),
  list: Object.freeze({ type: "list", nativeId: "800", canonicalUrl: "https://x.com/i/lists/800", name: "Fixture List", description: "Synthetic list", memberCount: 2, subscriberCount: 3, visibility: "public", createdAt: "2024-01-02T03:04:05.000Z" }),
});
