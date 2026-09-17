/*
 * Narrow protocol descriptors adapted from unclecode/twikit.
 * Copyright (c) 2024 d60. MIT licensed.
 * Source revision and per-file digests are recorded in THIRD_PARTY_NOTICES.md.
 * This is a source corpus, not a vendored or installed runtime dependency.
 */

import { createHash } from "node:crypto";
import { XContractError, assertFixtureOperation } from "./contract.mjs";

export const X_PROTOCOL_SOURCE = deepFreeze({
  project: "unclecode/twikit",
  revision: "6a73ab97f4de09f79139f6308c9fb80029a9f5f7",
  license: "MIT",
  repository: "https://github.com/unclecode/twikit",
  role: "source_corpus_only",
  runtimeDependency: false,
  files: [
    { path: "twikit/client/gql.py", gitBlob: "54d7d570d5d527a969a316b607591ee7cba56626", sha256: "f7236423a34b4a927088d880c50ba864c5d058c2b1fd89145b51eba86cc16586" },
    { path: "twikit/client/v11.py", gitBlob: "d4dbdda10d95d6066b1dd718ceb02261f93fd73f", sha256: "bbfa476ad88787f3058360366c526563fb9cb3af92e4a6180497b6d3a645e9d2" },
    { path: "twikit/client/client.py", gitBlob: "053f00879b944c8eeb371d001b9e5be67b986163", sha256: "6e7a26ca3a75352cc08f820f86e3385d8883046b39cff4742058697af5543c9c" },
    { path: "twikit/constants.py", gitBlob: "3d7dbb283814b9d20b12b48bb920164264a40e2a", sha256: "13ba330499173783db6b461cc0f75886f79aeebda4bcad765a239b88af90a29b" },
    { path: "LICENSE", gitBlob: "02c0ce95a5556628b8508cdbf1d05d39aef689a3", sha256: "71fec6fa5605fe7958564251e54ac0a8f7658e2915e2aa" },
    { path: "twikit/x_client_transaction/transaction.py", gitBlob: "d41703b5a90dbb57497c5dfd8d68e965c82bcd38", sha256: "8ec5776da51d98e67b4852db876c008167ff3a994bc1a6a88605ca2d6dd8bebc" },
    { path: "twikit/x_client_transaction/cubic_curve.py", gitBlob: "13fcc2ab131802d52b51a8005db9c7d0a9731ce8", sha256: "d07e3eed3ab249da8894e83b4a49e40d533748ef5bf94c887c6fe641dc6c8f8a" },
    { path: "twikit/x_client_transaction/interpolate.py", gitBlob: "4a879a2df8afa447587f0fff97d708f36e8d4ea1", sha256: "e3750845d16468a196b523e0d6092d3508b37cebf19ed4242c672ed534c5a520" },
    { path: "twikit/x_client_transaction/rotation.py", gitBlob: "c27f5f4f29d622e0350043d78cd309d9183b6549", sha256: "e9c9d4e5420093906eb4231dfdf8ae5f2623e633a83010e7a080d037a4a74dfd" },
    { path: "twikit/x_client_transaction/utils.py", gitBlob: "9fe0131ec215cb1a47fe45f1b4ccf2b579e157ac", sha256: "653410c06abf5391b8ec3e1ad4b6e792fec4f0f390dff44e5ddb1902427f82ee" },
  ],
});

/**
 * Inert-text observations from X's public responsive-web assets. These are
 * interoperability facts, not vendored or executable X code. The asset
 * filenames are content-addressed and the decoded-response SHA-256 digests
 * make the observation independently reproducible.
 *
 * This evidence refreshes GraphQL identifiers only. It does not prove current
 * feature-switch values, response shapes, authenticated acceptance, or any
 * v1.1 endpoint, so it must not satisfy the production-currentness gate.
 */
export const X_PUBLIC_PROTOCOL_EVIDENCE = deepFreeze({
  observedAt: "2026-09-17T04:45:14Z",
  sourceRole: "public_inert_asset_observation",
  productionAdmission: "partial_evidence_only",
  assets: [
    {
      url: "https://abs.twimg.com/responsive-web/client-web/main.52fc4dd0aada586aa.js",
      sha256: "21281352cc76180da5ba07445540bee112fe771eec4beeab3889811e9443ff06",
      decodedBytes: 1177543,
    },
    {
      url: "https://abs.twimg.com/responsive-web/client-web/shared~bundle.BookmarkFolders~bundle.Bookmarks.12cb1875a99ef5b3a.js",
      sha256: "5a845b8ad9becaa9b03ebc5373f7965455dd63be6dd926e3dd676f807652b762",
      decodedBytes: 107390,
    },
    {
      url: "https://abs.twimg.com/responsive-web/client-web/shared~bundle.LoggedInMain~bundle.HomeTimeline~bundle.Compose.d2799da549fa4165a.js",
      sha256: "f3ee2a719701588db86096f649e7ff5dc8a2134b0776df8a8706d2eed03d5bdd",
      decodedBytes: 29347,
    },
    {
      url: "https://abs.twimg.com/responsive-web/client-web/ondemand.s.ca394a8e50ecfeaaa.js",
      sha256: "39e3a536d00504564972f8db2198816c951b89752d054543ef30c2bcb2481ece",
      decodedBytes: 18869,
    },
  ],
  queryIds: {
    UserByScreenName: "KybxDj9RrADIITXlGG8kpw",
    TweetResultByRestId: "Xl0tsHf4AzflMRjbw9e70A",
    TweetDetail: "zoF7_t363wZyzylk-BLfZQ",
    HomeTimeline: "og4a4SdSF3WiQkkwaPCdPg",
    UserTweets: "jeAA-59Y9FL7FmjgBNIVPw",
    SearchTimeline: "auLkqtmHqYEpRvflfvLhyQ",
    Bookmarks: "-dgKZ58Dr9YSJYrcgEb5KA",
    Followers: "fVGYs5W9kNUuoUrZwYZQpQ",
    Following: "-Mn4uN7C-vxXBwUKtSwS6A",
    CreateTweet: "GYdIGqVWfZNho79bQ2XDoA",
    DeleteTweet: "nxpZCY2K-I6QoFHAHeojFQ",
    FavoriteTweet: "lI07N6Otwv1PhnEgXILM7A",
    UnfavoriteTweet: "ZYKSe-w7KEslx3JhSIk5LA",
    CreateRetweet: "mbRO74GrOvSfRcJnlMapnQ",
    DeleteRetweet: "ZyZigVsNiFO6v1dEks1eWg",
    CreateBookmark: "aoDbu3RHznuiSkQ9aNM67Q",
    DeleteBookmark: "Wlmlj2-xzyS1GN3a6cj-mQ",
  },
  unresolved: [
    "GRAPHQL_FEATURE_VALUES_UNPROVEN",
    "V11_ENDPOINT_CURRENTNESS_UNPROVEN",
    "AUTHENTICATED_ACCEPTANCE_UNPROVEN",
    "RESPONSE_SHAPE_CURRENTNESS_UNPROVEN",
  ],
});

const gql = (queryId, name, method = "GET", submission = method === "POST" ? "SINGLE_ATTEMPT" : "READ_ONLY") => ({ target: "web", method, path: `/i/api/graphql/${queryId}/${name}`, queryId, submission });
const v11 = (path, method = "GET", target = "web") => ({ target, method, path, submission: method === "POST" ? "SINGLE_ATTEMPT" : "READ_ONLY" });

export const X_PROTOCOL_ROUTES = deepFreeze({
  "account.identity": v11("/1.1/account/settings.json", "GET", "api"),
  "profile.get": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.UserByScreenName, "UserByScreenName"),
  "post.get": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.TweetResultByRestId, "TweetResultByRestId"),
  "thread.get": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.TweetDetail, "TweetDetail"),
  "timeline.home": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.HomeTimeline, "HomeTimeline", "POST", "READ_ONLY"),
  "timeline.user": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.UserTweets, "UserTweets"),
  "search.query": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.SearchTimeline, "SearchTimeline"),
  "notifications.list": v11("/i/api/2/notifications/all.json"),
  "conversations.list": v11("/i/api/1.1/dm/inbox_initial_state.json"),
  "bookmarks.list": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.Bookmarks, "Bookmarks"),
  "followers.list": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.Followers, "Followers"),
  "following.list": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.Following, "Following"),
  "lists.lookup": gql("9hbYpeVBMq8-yB8slayGWQ", "ListByRestId"),
  "lists.memberships": gql("47170qwZCt5aFo9cBwFoNA", "ListsManagementPageTimeline"),
  "lists.members": gql("BQp2IEYkgxuSxqbTAr1e1g", "ListMembers"),
  "lists.timeline": gql("HjsWc-nwwHKYwHenbHm-tw", "ListLatestTweetsTimeline"),
  "post.create": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateTweet, "CreateTweet", "POST"),
  "post.reply": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateTweet, "CreateTweet", "POST"),
  "post.delete": gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.DeleteTweet, "DeleteTweet", "POST"),
  "post.like.set": Object.freeze({ enable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.FavoriteTweet, "FavoriteTweet", "POST"), disable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.UnfavoriteTweet, "UnfavoriteTweet", "POST") }),
  "post.repost.set": Object.freeze({ enable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateRetweet, "CreateRetweet", "POST"), disable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.DeleteRetweet, "DeleteRetweet", "POST") }),
  "profile.follow.set": Object.freeze({ enable: v11("/i/api/1.1/friendships/create.json", "POST"), disable: v11("/i/api/1.1/friendships/destroy.json", "POST") }),
  "bookmark.set": Object.freeze({ enable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateBookmark, "CreateBookmark", "POST"), disable: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.DeleteBookmark, "DeleteBookmark", "POST") }),
  "post.media.create": Object.freeze({
    init: v11("/i/media/upload.json", "POST", "upload"),
    append: v11("/i/media/upload.json", "POST", "upload"),
    finalize: v11("/i/media/upload.json", "POST", "upload"),
    submit: gql(X_PUBLIC_PROTOCOL_EVIDENCE.queryIds.CreateTweet, "CreateTweet", "POST"),
  }),
  "message.send": v11("/i/api/1.1/dm/new2.json", "POST"),
});

const COMMON_FEATURES = deepFreeze({
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
});

export function buildXProtocolRequest(operation, input = {}, phase) {
  assertFixtureOperation(operation);
  const value = plain(input);
  const route = selectRoute(operation, value, phase);
  let variables;
  switch (operation) {
    case "account.identity": variables = null; break;
    case "profile.get": variables = { screen_name: username(value.username), withSafetyModeUserFields: false }; break;
    case "post.get": variables = { tweetId: nativeId(value.postId), withCommunity: true, includePromotedContent: false }; break;
    case "thread.get": variables = { focalTweetId: nativeId(value.postId), count: limit(value.limit), with_rux_injections: false, includePromotedContent: false, withCommunity: true, withV2Timeline: true, ...cursor(value.cursor) }; break;
    case "timeline.home": variables = { count: limit(value.limit), includePromotedContent: false, latestControlAvailable: true, requestContext: "launch", withCommunity: true, seenTweetIds: [], ...cursor(value.cursor) }; break;
    case "timeline.user": variables = { userId: nativeId(value.userNativeId), count: limit(value.limit), includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false, withVoice: true, withV2Timeline: true, ...cursor(value.cursor) }; break;
    case "search.query": variables = { rawQuery: bounded(value.query, "query", 512), count: limit(value.limit), querySource: "typed_query", product: "Latest", ...cursor(value.cursor) }; break;
    case "notifications.list": return descriptor(route, query({ count: limit(value.limit), ...cursor(value.cursor) }), null, operation);
    case "conversations.list": return descriptor(route, query({ include_profile_interstitial_type: "1", include_ext_alt_text: "true", dm_secret_conversations_enabled: "false", krs_registration_enabled: "true" }), null, operation);
    case "bookmarks.list": variables = { count: limit(value.limit), includePromotedContent: false, ...cursor(value.cursor) }; break;
    case "followers.list":
    case "following.list": variables = { userId: nativeId(value.userNativeId), count: limit(value.limit), includePromotedContent: false, ...cursor(value.cursor) }; break;
    case "lists.lookup": variables = { listId: nativeId(value.listId) }; break;
    case "lists.memberships": variables = { count: limit(value.limit), ...cursor(value.cursor) }; break;
    case "lists.members": variables = { listId: nativeId(value.listId), count: limit(value.limit), ...cursor(value.cursor) }; break;
    case "lists.timeline": variables = { listId: nativeId(value.listId), count: limit(value.limit), ...cursor(value.cursor) }; break;
    case "post.create": variables = createPostVariables(bounded(value.text, "text", 280)); break;
    case "post.reply": variables = { ...createPostVariables(bounded(value.text, "text", 280)), reply: { in_reply_to_tweet_id: nativeId(value.postId), exclude_reply_user_ids: [] } }; break;
    case "post.delete": variables = { tweet_id: nativeId(value.postId), dark_request: false }; break;
    case "post.like.set": variables = { tweet_id: nativeId(value.postId) }; break;
    case "post.repost.set": variables = value.enabled === false ? { source_tweet_id: nativeId(value.postId), dark_request: false } : { tweet_id: nativeId(value.postId), dark_request: false }; break;
    case "profile.follow.set": return descriptor(route, "", form({ user_id: nativeId(value.userNativeId), skip_status: "1" }), operation, "application/x-www-form-urlencoded");
    case "bookmark.set": variables = { tweet_id: nativeId(value.postId) }; break;
    case "message.send": return descriptor(route, "", json({ cards_platform: "Web-12", conversation_id: conversationId(value.conversationId), dm_users: false, include_cards: 1, include_quote_count: true, recipient_ids: false, text: bounded(value.text, "text", 10_000) }), operation);
    case "post.media.create": return buildMedia(route, value, phase);
    default: throw invalid("The X protocol operation is not mapped.");
  }
  if (variables === null) return descriptor(route, "", null, operation);
  if (route.method === "GET") return descriptor(route, query({ variables: JSON.stringify(variables), features: JSON.stringify(COMMON_FEATURES) }), null, operation);
  return descriptor(route, "", json({ variables, queryId: route.queryId, features: COMMON_FEATURES }), operation);
}

function selectRoute(operation, input, phase) {
  const value = X_PROTOCOL_ROUTES[operation];
  if (!value) throw invalid("The X protocol route is missing.");
  if (operation === "post.media.create") {
    if (!new Set(["init", "append", "finalize", "submit"]).has(phase)) throw invalid("The X media phase is invalid.");
    return value[phase];
  }
  if (value.enable && value.disable) return input.enabled === false ? value.disable : value.enable;
  return value;
}

function buildMedia(route, input, phase) {
  if (phase === "init") return descriptor(route, query({ command: "INIT", total_bytes: bytes(input.sizeBytes), media_type: mime(input.mimeType), media_category: "tweet_image" }), Buffer.alloc(0), "post.media.create");
  if (phase === "append") {
    const framed = multipartMedia(bytesBody(input.data));
    return descriptor(route, query({ command: "APPEND", media_id: nativeId(input.mediaId), segment_index: "0" }), framed.body, "post.media.create", framed.contentType);
  }
  if (phase === "finalize") return descriptor(route, query({ command: "FINALIZE", media_id: nativeId(input.mediaId) }), Buffer.alloc(0), "post.media.create");
  const variables = createPostVariables(bounded(input.text ?? "", "text", 280, true), [{ media_id: nativeId(input.mediaId), tagged_users: [] }]);
  return descriptor(route, "", json({ variables, queryId: route.queryId, features: COMMON_FEATURES }), "post.media.create");
}

function createPostVariables(text, media_entities = []) { return { tweet_text: text, dark_request: false, media: { media_entities, possibly_sensitive: false }, semantic_annotation_ids: [] }; }
function descriptor(route, search, body, operation, contentType = body === null ? null : "application/json") { return deepFreeze({ operation, target: route.target, method: route.method, path: `${route.path}${search}`, body, contentType, submission: route.submission }); }
function query(values) { const params = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value)); const encoded = params.toString(); return encoded ? `?${encoded}` : ""; }
function json(value) { return Buffer.from(JSON.stringify(value), "utf8"); }
function form(value) { return Buffer.from(new URLSearchParams(value).toString(), "utf8"); }
function cursor(value) { return value === undefined || value === null ? {} : { cursor: bounded(value, "cursor", 512) }; }
function nativeId(value) { const text = bounded(value, "native ID", 128); if (!/^\d+$/u.test(text)) throw invalid("The X native ID is invalid."); return text; }
function username(value) { const text = bounded(value, "username", 15); if (!/^[A-Za-z0-9_]{1,15}$/u.test(text)) throw invalid("The X username is invalid."); return text; }
function conversationId(value) { const text = bounded(value, "conversation ID", 260); if (!/^\d+(?:-\d+)?$/u.test(text)) throw invalid("The X conversation ID is invalid."); return text; }
function limit(value) { const number = value === undefined ? 25 : value; if (!Number.isSafeInteger(number) || number < 1 || number > 100) throw invalid("The X page limit is invalid."); return number; }
function bytes(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 8 * 1024 * 1024) throw invalid("The X media size is invalid."); return String(value); }
function mime(value) { if (!new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(value)) throw invalid("The X media MIME type is invalid."); return value; }
function bytesBody(value) { if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 8 * 1024 * 1024) throw invalid("The X media bytes are invalid."); return Buffer.from(value); }
function multipartMedia(data) {
  // The pinned client sends APPEND as a multipart `media` file named `blob`
  // with application/octet-stream content. The digest-derived boundary keeps
  // framing deterministic without exposing caller-selected header material.
  const boundary = `socialgit-x-${createDigest(data)}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`, "utf8");
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([prefix, data, suffix]), contentType: `multipart/form-data; boundary=${boundary}` };
}
function createDigest(value) { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function bounded(value, label, maximum, allowEmpty = false) { if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length < 1) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid(`The X ${label} is invalid.`); return value; }
function plain(value) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid("The X protocol input must be a plain object."); return value; }
function invalid(message) { return new XContractError("INVALID_REQUEST", message); }
function deepFreeze(value) { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
