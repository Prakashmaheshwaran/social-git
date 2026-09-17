/*
 * Narrow protocol descriptors adapted from unclecode/twikit.
 * Copyright (c) 2024 d60. MIT licensed.
 * Source revision and per-file digests are recorded in THIRD_PARTY_NOTICES.md.
 * This is a source corpus, not a vendored or installed runtime dependency.
 */

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

const gql = (queryId, name, method = "GET", submission = method === "POST" ? "SINGLE_ATTEMPT" : "READ_ONLY") => ({ target: "web", method, path: `/i/api/graphql/${queryId}/${name}`, queryId, submission });
const v11 = (path, method = "GET", target = "web") => ({ target, method, path, submission: method === "POST" ? "SINGLE_ATTEMPT" : "READ_ONLY" });

export const X_PROTOCOL_ROUTES = deepFreeze({
  "account.identity": v11("/1.1/account/settings.json", "GET", "api"),
  "profile.get": gql("NimuplG1OB7Fd2btCLdBOw", "UserByScreenName"),
  "post.get": gql("Xl5pC_lBk_gcO2ItU39DQw", "TweetResultByRestId"),
  "thread.get": gql("U0HTv-bAWTBYylwEMT7x5A", "TweetDetail"),
  "timeline.home": gql("-X_hcgQzmHGl29-UXxz4sw", "HomeTimeline", "POST", "READ_ONLY"),
  "timeline.user": gql("QWF3SzpHmykQHsQMixG0cg", "UserTweets"),
  "search.query": gql("flaR-PUMshxFWZWPNpq4zA", "SearchTimeline"),
  "notifications.list": v11("/i/api/2/notifications/all.json"),
  "conversations.list": v11("/i/api/1.1/dm/inbox_initial_state.json"),
  "bookmarks.list": gql("qToeLeMs43Q8cr7tRYXmaQ", "Bookmarks"),
  "post.create": gql("SiM_cAu83R0wnrpmKQQSEw", "CreateTweet", "POST"),
  "post.reply": gql("SiM_cAu83R0wnrpmKQQSEw", "CreateTweet", "POST"),
  "post.delete": gql("VaenaVgh5q5ih7kvyVjgtg", "DeleteTweet", "POST"),
  "post.like.set": Object.freeze({ enable: gql("lI07N6Otwv1PhnEgXILM7A", "FavoriteTweet", "POST"), disable: gql("ZYKSe-w7KEslx3JhSIk5LA", "UnfavoriteTweet", "POST") }),
  "post.repost.set": Object.freeze({ enable: gql("ojPdsZsimiJrUGLR1sjUtA", "CreateRetweet", "POST"), disable: gql("iQtK4dl5hBmXewYZuEOKVw", "DeleteRetweet", "POST") }),
  "profile.follow.set": Object.freeze({ enable: v11("/i/api/1.1/friendships/create.json", "POST"), disable: v11("/i/api/1.1/friendships/destroy.json", "POST") }),
  "bookmark.set": Object.freeze({ enable: gql("aoDbu3RHznuiSkQ9aNM67Q", "CreateBookmark", "POST"), disable: gql("Wlmlj2-xzyS1GN3a6cj-mQ", "DeleteBookmark", "POST") }),
  "post.media.create": Object.freeze({
    init: v11("/i/media/upload.json", "POST", "upload"),
    append: v11("/i/media/upload.json", "POST", "upload"),
    finalize: v11("/i/media/upload.json", "POST", "upload"),
    submit: gql("SiM_cAu83R0wnrpmKQQSEw", "CreateTweet", "POST"),
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
    case "post.create": variables = createPostVariables(bounded(value.text, "text", 280)); break;
    case "post.reply": variables = { ...createPostVariables(bounded(value.text, "text", 280)), reply: { in_reply_to_tweet_id: nativeId(value.postId), exclude_reply_user_ids: [] } }; break;
    case "post.delete": variables = { tweet_id: nativeId(value.postId), dark_request: false }; break;
    case "post.like.set": variables = { tweet_id: nativeId(value.postId) }; break;
    case "post.repost.set": variables = value.enabled === false ? { source_tweet_id: nativeId(value.postId), dark_request: false } : { tweet_id: nativeId(value.postId), dark_request: false }; break;
    case "profile.follow.set": return descriptor(route, "", form({ user_id: nativeId(value.userNativeId), skip_status: "1" }), operation);
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
  if (phase === "append") return descriptor(route, query({ command: "APPEND", media_id: nativeId(input.mediaId), segment_index: "0" }), bytesBody(input.data), "post.media.create");
  if (phase === "finalize") return descriptor(route, query({ command: "FINALIZE", media_id: nativeId(input.mediaId) }), Buffer.alloc(0), "post.media.create");
  const variables = createPostVariables(bounded(input.text ?? "", "text", 280, true), [{ media_id: nativeId(input.mediaId), tagged_users: [] }]);
  return descriptor(route, "", json({ variables, queryId: route.queryId, features: COMMON_FEATURES }), "post.media.create");
}

function createPostVariables(text, media_entities = []) { return { tweet_text: text, dark_request: false, media: { media_entities, possibly_sensitive: false }, semantic_annotation_ids: [] }; }
function descriptor(route, search, body, operation) { return deepFreeze({ operation, target: route.target, method: route.method, path: `${route.path}${search}`, body, submission: route.submission }); }
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
function bounded(value, label, maximum, allowEmpty = false) { if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length < 1) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid(`The X ${label} is invalid.`); return value; }
function plain(value) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid("The X protocol input must be a plain object."); return value; }
function invalid(message) { return new XContractError("INVALID_REQUEST", message); }
function deepFreeze(value) { if (value && typeof value === "object" && !ArrayBuffer.isView(value) && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; }
