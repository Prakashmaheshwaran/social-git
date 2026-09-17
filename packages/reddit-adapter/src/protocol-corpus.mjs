/*
 * Bounded source extraction adapted from reddit-lyr's RedditAPIClient.
 * Copyright (c) 2026 Ishan Parihar. MIT licensed.
 * Source: https://github.com/ishan-parihar/reddit-lyr
 * Revision: 87ec32aff905923ecd156e7951c168adfdf6fac1
 * The full notice and file provenance are in ../THIRD_PARTY_NOTICES.md.
 */

import {
  AdapterContractError,
  CORE_ERROR_CODES,
  PROTOCOL_MAPPING_STATUS,
  assertSupportedOperation
} from "./contract.mjs";
import { validateOperationInput } from "./validation.mjs";

export const REDDIT_PROTOCOL_SOURCE = deepFreeze({
  project: "reddit-lyr",
  manifestVersion: "0.1.1",
  revision: "87ec32aff905923ecd156e7951c168adfdf6fac1",
  license: "MIT",
  repository: "https://github.com/ishan-parihar/reddit-lyr",
  files: [
    {
      path: "reddit_mcp_server/scraping/api_client.py",
      gitBlob: "1a18f05cb12c80094826365557f06dda7953a499",
      sha256: "f1c4a33c06e5357b790801d81b849d98e108ca081cecd4ac03563b7ab727185f"
    },
    {
      path: "reddit_mcp_server/normalizer.py",
      gitBlob: "c6be236df1b349d9d38a42f3f90e1b7815a0bfae",
      sha256: "f552d8853827a1538b9d354c96351b302125200680f2af33b8a0653169151f54"
    },
    {
      path: "reddit_mcp_server/tools/messaging.py",
      gitBlob: "27d9be6534f546db1df08e956da95b3b406478c7",
      sha256: "4f162c3460c67215030f09397603c47c1016f83d6d7077e22c0f04a8d70ffb2c"
    }
  ]
});

export const REDDIT_PROTOCOL_SUPPORTING_SOURCES = deepFreeze([
  {
    project: "PRAW",
    version: "8.0.3",
    revision: "fdc29bb103ad652eea6740c77c2be099d1c1357e",
    license: "BSD-2-Clause",
    repository: "https://github.com/praw-dev/praw",
    use: "Protocol evidence only; the package, OAuth transport, and retry behavior are not used",
    files: [
      {
        path: "praw/endpoints.py",
        gitBlob: "5fe4de568f3bda0fec2c1c3e8f3c57d52f3354b9",
        sha256: "487c557e5289a432055ddbb5cc2d4793df63a2805fc66412e3cb0936b0d76299"
      },
      {
        path: "praw/models/media.py",
        gitBlob: "e865049549deabd62cb0b05916e5266bf152876f",
        sha256: "d84de7a378a1bb512428359ac3fd7f9bcdd5fb307b4befdfce3fd742c538f530"
      },
      {
        path: "praw/models/reddit/subreddit/subreddit.py",
        gitBlob: "64f87f83150f471cf6310d48ea0f626c2790feb1",
        sha256: "c01634ba8c69e786b09bab10ef5495cb51244743c4dc4e2cef0f2e1c246d68b6"
      },
      {
        path: "praw/reddit.py",
        gitBlob: "b240ec0102f493b7f7d1265661500dfa05c419d3",
        sha256: "180186fa70aa31a9566adc19e06e211f174fbb3ecc18110f183e7b1580fc1eaf"
      },
      {
        path: "praw/models/inbox.py",
        gitBlob: "966160188094154de4517360f45a38cd6051bb10",
        sha256: "5c6eff20fdf7080f1217ed309944bd9489cc5bb14463a9fd95b932a0d6a174cb"
      },
      {
        path: "praw/models/reddit/message.py",
        gitBlob: "3880427d1c45be1faa0272a8242b0ec5b72094b7",
        sha256: "f17c729373b060ece127c54352f09b076f280a9626267788339ce6ea0a1da773"
      },
      {
        path: "praw/models/reddit/mixins/messageable.py",
        gitBlob: "ba14f5e187d01ec42509b9e2220be28ae4e4f8f6",
        sha256: "710e1330f86bc7d60defb3c448dadf06ac608d318938821e9575aa2f7bb8f41e"
      },
      {
        path: "praw/models/reddit/mixins/replyable.py",
        gitBlob: "b5e422c418dffbe3bfe881a2e71ed58ea28f11ea",
        sha256: "ab581a5267b7d7163cbb1357070a40142e2aac1d3c3f44e02fb6baa08534cbdc"
      }
    ]
  }
]);

export const REDDIT_OWNERSHIP_LOOKUP_ROUTE = deepFreeze({
  method: "GET",
  pathTemplate: "/api/info.json?id={nativeFullname}&raw_json=1",
  normalizer: "single_item_listing",
  submission: "READ_ONLY",
  source: "PRAW 8.0.3 Reddit.info"
});

export const REDDIT_MEDIA_PROTOCOL = deepFreeze({
  lease: { method: "POST", path: "/api/media/asset.json", submission: "PREFLIGHT" },
  upload: {
    method: "POST",
    origin: "https://reddit-uploaded-media.s3-accelerate.amazonaws.com",
    submission: "PREFLIGHT"
  },
  submit: { method: "POST", path: "/api/submit", submission: "SINGLE_ATTEMPT" },
  process: { method: "WSS", origin: "wss://wss.redditmedia.com", submission: "READ_ONLY_AFTER_SUBMIT" }
});

/**
 * Source-reviewed messaging shapes that remain deliberately outside the
 * production route table. These descriptors can be built only by the explicit
 * candidate builder and executed only with a process-local test admission.
 * No production configuration path creates that admission.
 */
export const REDDIT_MESSAGING_CANDIDATE = deepFreeze({
  source: REDDIT_PROTOCOL_SOURCE,
  routes: {
    "message.inbox": {
      method: "GET",
      pathTemplate: "/message/{inbox|unread|messages|sent|mentions}.json",
      normalizer: "message_listing_candidate",
      nativeKind: "t4",
      productionEnabled: false,
      disabledReasons: ["AUTHORIZED_LIVE_INBOX_PROOF_MISSING"]
    },
    "message.thread": {
      method: "GET",
      pathTemplate: "/message/messages/{messageIdShort}.json",
      normalizer: "message_thread_candidate",
      nativeKind: "t4",
      productionEnabled: false,
      disabledReasons: ["DIRECT_SESSION_THREAD_MAPPING_UNPROVEN"]
    },
    "message.send": {
      method: "POST",
      pathTemplate: "/api/compose",
      normalizer: "message_compose_correlation_candidate",
      nativeKind: "t4",
      submission: "SINGLE_ATTEMPT",
      productionEnabled: false,
      disabledReasons: ["NO_VERIFIABLE_NATIVE_RESULT", "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"]
    },
    "message.reply": {
      method: "POST",
      pathTemplate: "/api/comment",
      normalizer: "message_reply_candidate",
      nativeKind: "t4",
      submission: "SINGLE_ATTEMPT",
      productionEnabled: false,
      disabledReasons: ["DIRECT_SESSION_REPLY_MAPPING_UNPROVEN", "AUTHORIZED_LIVE_WRITE_PROOF_MISSING"]
    }
  }
});

export function buildRedditMessagingCandidateRequest(operation, input) {
  if (!Object.hasOwn(REDDIT_MESSAGING_CANDIDATE.routes, operation)) {
    throw new AdapterContractError(CORE_ERROR_CODES.UNKNOWN_OPERATION, "Unknown Reddit messaging candidate operation");
  }
  const validatedInput = structuredClone(input);
  validateOperationInput(operation, validatedInput);
  let request;
  switch (operation) {
    case "message.inbox":
      request = {
        operation,
        method: "GET",
        path: `/message/${validatedInput.folder}.json`,
        query: compact({ limit: validatedInput.limit ?? 25, after: validatedInput.after, raw_json: 1 }),
        body: null,
        normalizer: "message_listing_candidate",
        submission: "READ_ONLY",
        requiresWorkerModhash: false
      };
      break;
    case "message.thread":
      request = {
        operation,
        method: "GET",
        path: `/message/messages/${shortMessageId(validatedInput.messageNativeId)}.json`,
        query: { raw_json: 1 },
        body: null,
        normalizer: "message_thread_candidate",
        submission: "READ_ONLY",
        requiresWorkerModhash: false
      };
      break;
    case "message.send":
      request = {
        operation,
        method: "POST",
        path: "/api/compose",
        query: { raw_json: 1 },
        body: { api_type: "json", to: validatedInput.recipient, subject: validatedInput.subject, text: validatedInput.body },
        normalizer: "message_compose_correlation_candidate",
        submission: "SINGLE_ATTEMPT",
        requiresWorkerModhash: true
      };
      break;
    case "message.reply":
      request = {
        operation,
        method: "POST",
        path: "/api/comment",
        query: { raw_json: 1 },
        body: { api_type: "json", thing_id: validatedInput.parentMessageNativeId, text: validatedInput.body },
        normalizer: "message_reply_candidate",
        submission: "SINGLE_ATTEMPT",
        requiresWorkerModhash: true
      };
      break;
  }
  return deepFreeze(request);
}

export const REDDIT_PROTOCOL_ROUTES = deepFreeze({
  "profile.get": {
    method: "GET",
    pathTemplate: "/api/me.json",
    normalizer: "profile",
    submission: "READ_ONLY"
  },
  "subreddit.get": {
    method: "GET",
    pathTemplate: "/r/{subreddit}/about.json",
    normalizer: "subreddit",
    submission: "READ_ONLY"
  },
  "listing.list": {
    method: "GET",
    pathTemplate: "/{sort}.json or /r/{subreddit}/{sort}.json",
    normalizer: "listing",
    submission: "READ_ONLY"
  },
  "post.get": {
    method: "GET",
    pathTemplate: "/comments/{postId}.json",
    normalizer: "post_thread",
    submission: "READ_ONLY"
  },
  "comments.list": {
    method: "GET",
    pathTemplate: "/comments/{postId}.json",
    normalizer: "post_thread_comments",
    submission: "READ_ONLY"
  },
  "search.query": {
    method: "GET",
    pathTemplate: "/search.json or /r/{subreddit}/search.json",
    normalizer: "listing",
    submission: "READ_ONLY"
  },
  "user.get": {
    method: "GET",
    pathTemplate: "/user/{username}/about.json",
    normalizer: "profile",
    submission: "READ_ONLY"
  },
  "user.content": {
    method: "GET",
    pathTemplate: "/user/{username}/{submitted|comments}.json",
    normalizer: "typed_listing",
    submission: "READ_ONLY"
  },
  "account.saved": {
    method: "GET",
    pathTemplate: "/user/{authenticatedUsername}/saved.json",
    normalizer: "mixed_listing",
    submission: "READ_ONLY"
  },
  "account.upvoted": {
    method: "GET",
    pathTemplate: "/user/{authenticatedUsername}/upvoted.json",
    normalizer: "mixed_listing",
    submission: "READ_ONLY"
  },
  "post.createText": {
    method: "POST",
    pathTemplate: "/api/submit",
    normalizer: "created_post",
    submission: "SINGLE_ATTEMPT"
  },
  "post.createLink": {
    method: "POST",
    pathTemplate: "/api/submit",
    normalizer: "created_post",
    submission: "SINGLE_ATTEMPT"
  },
  "post.createMedia": {
    method: "POST",
    pathTemplate: "/api/media/asset.json -> admitted S3 upload -> /api/submit -> admitted WSS result",
    normalizer: "media_state_machine",
    submission: "MULTI_PHASE"
  },
  "comment.create": {
    method: "POST",
    pathTemplate: "/api/comment",
    normalizer: "created_comment",
    submission: "SINGLE_ATTEMPT"
  },
  "reply.create": {
    method: "POST",
    pathTemplate: "/api/comment",
    normalizer: "created_comment",
    submission: "SINGLE_ATTEMPT"
  },
  "item.editOwn": {
    method: "POST",
    pathTemplate: "/api/editusertext",
    normalizer: "existing_item",
    submission: "SINGLE_ATTEMPT"
  },
  "vote.set": {
    method: "POST",
    pathTemplate: "/api/vote",
    normalizer: "existing_item",
    submission: "SINGLE_ATTEMPT"
  },
  "save.set": {
    method: "POST",
    pathTemplate: "/api/save",
    normalizer: "existing_item",
    submission: "SINGLE_ATTEMPT"
  },
  "save.unset": {
    method: "POST",
    pathTemplate: "/api/unsave",
    normalizer: "existing_item",
    submission: "SINGLE_ATTEMPT"
  },
  "subreddit.subscribe": {
    method: "POST",
    pathTemplate: "/api/subscribe",
    normalizer: "existing_subreddit",
    submission: "SINGLE_ATTEMPT"
  },
  "subreddit.unsubscribe": {
    method: "POST",
    pathTemplate: "/api/subscribe",
    normalizer: "existing_subreddit",
    submission: "SINGLE_ATTEMPT"
  },
  "item.deleteOwn": {
    method: "POST",
    pathTemplate: "/api/del",
    normalizer: "deleted_item",
    submission: "SINGLE_ATTEMPT"
  }
});

export function buildRedditProtocolRequest(operation, input, trusted = {}) {
  const capability = assertSupportedOperation(operation);
  if (capability.protocolMapping !== PROTOCOL_MAPPING_STATUS.MAPPED) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.CAPABILITY_DISABLED,
      `Reddit operation ${operation} has no admitted protocol mapping`
    );
  }
  if (operation === "post.createMedia") {
    throw new AdapterContractError(
      CORE_ERROR_CODES.INVALID_REQUEST,
      "Reddit media requires the Core-managed phased transport"
    );
  }

  const validatedInput = structuredClone(input);
  validateOperationInput(operation, validatedInput);

  let request;
  switch (operation) {
    case "profile.get":
      request = readRequest(operation, "/api/me.json");
      break;
    case "subreddit.get":
      request = readRequest(operation, `/r/${validatedInput.name}/about.json`, { raw_json: 1 });
      break;
    case "listing.list": {
      const sort = validatedInput.kind ?? (validatedInput.subreddit ? "hot" : "best");
      const path = validatedInput.subreddit
        ? `/r/${validatedInput.subreddit}/${sort}.json`
        : `/${sort}.json`;
      request = readRequest(operation, path, compact({
        limit: validatedInput.limit ?? 25,
        raw_json: 1,
        ...(validatedInput.timeframe ? { t: validatedInput.timeframe } : (validatedInput.subreddit ? { t: "day" } : {})),
        after: validatedInput.after
      }));
      break;
    }
    case "post.get":
      request = readRequest(operation, `/comments/${shortPostId(validatedInput.nativeId)}.json`, {
        sort: "best",
        limit: 50,
        raw_json: 1
      });
      break;
    case "comments.list":
      request = readRequest(operation, `/comments/${shortPostId(validatedInput.postNativeId)}.json`, compact({
        sort: validatedInput.sort ?? "best",
        limit: validatedInput.limit ?? 50,
        raw_json: 1,
        after: validatedInput.after
      }));
      break;
    case "search.query": {
      const path = validatedInput.subreddit
        ? `/r/${validatedInput.subreddit}/search.json`
        : "/search.json";
      request = readRequest(operation, path, compact({
        q: validatedInput.query,
        sort: validatedInput.sort ?? "relevance",
        t: validatedInput.timeframe ?? "all",
        limit: validatedInput.limit ?? 25,
        raw_json: 1,
        type: "link",
        after: validatedInput.after,
        ...(validatedInput.subreddit ? { restrict_sr: "on" } : {})
      }));
      break;
    }
    case "user.get":
      request = readRequest(operation, `/user/${validatedInput.username}/about.json`, { raw_json: 1 });
      break;
    case "user.content":
      request = readRequest(operation, `/user/${validatedInput.username}/${validatedInput.content}.json`, compact({
        sort: validatedInput.sort ?? "new",
        t: validatedInput.timeframe ?? "all",
        limit: validatedInput.limit ?? 25,
        after: validatedInput.after,
        raw_json: 1
      }));
      break;
    case "account.saved":
    case "account.upvoted": {
      const username = trusted.authenticatedUsername;
      if (typeof username !== "string" || !/^[A-Za-z0-9_-]{3,20}$/u.test(username)) {
        throw new AdapterContractError(CORE_ERROR_CODES.WRONG_IDENTITY, "A validated authenticated Reddit username is required");
      }
      const listing = operation === "account.saved" ? "saved" : "upvoted";
      request = readRequest(operation, `/user/${username}/${listing}.json`, compact({
        limit: trusted.limit ?? 25,
        after: trusted.after,
        raw_json: 1
      }));
      break;
    }
    case "post.createText":
      request = writeRequest(operation, "/api/submit", {
        api_type: "json",
        sr: validatedInput.subreddit,
        kind: "self",
        title: validatedInput.title,
        text: validatedInput.body,
        nsfw: validatedInput.nsfw ?? false,
        spoiler: validatedInput.spoiler ?? false
      });
      break;
    case "post.createLink":
      request = writeRequest(operation, "/api/submit", {
        api_type: "json",
        sr: validatedInput.subreddit,
        kind: "link",
        title: validatedInput.title,
        url: validatedInput.url,
        nsfw: validatedInput.nsfw ?? false
      });
      break;
    case "comment.create":
      request = writeRequest(operation, "/api/comment", {
        api_type: "json",
        thing_id: validatedInput.postNativeId,
        text: validatedInput.body
      });
      break;
    case "reply.create":
      request = writeRequest(operation, "/api/comment", {
        api_type: "json",
        thing_id: validatedInput.commentNativeId,
        text: validatedInput.body
      });
      break;
    case "item.editOwn":
      request = writeRequest(operation, "/api/editusertext", {
        api_type: "json",
        thing_id: validatedInput.nativeId,
        text: validatedInput.body
      });
      break;
    case "vote.set":
      request = writeRequest(operation, "/api/vote", {
        api_type: "json",
        id: validatedInput.nativeId,
        dir: String(validatedInput.direction)
      });
      break;
    case "save.set":
      request = writeRequest(operation, "/api/save", { api_type: "json", id: validatedInput.nativeId });
      break;
    case "save.unset":
      request = writeRequest(operation, "/api/unsave", { api_type: "json", id: validatedInput.nativeId });
      break;
    case "subreddit.subscribe":
    case "subreddit.unsubscribe":
      request = writeRequest(operation, "/api/subscribe", {
        api_type: "json",
        sr_name: validatedInput.subreddit,
        action: operation === "subreddit.subscribe" ? "sub" : "unsub"
      });
      break;
    case "item.deleteOwn":
      request = writeRequest(operation, "/api/del", { api_type: "json", id: validatedInput.nativeId });
      break;
    default:
      throw new AdapterContractError(
        CORE_ERROR_CODES.CAPABILITY_DISABLED,
        `Reddit operation ${operation} has no admitted request builder`
      );
  }

  return deepFreeze(request);
}

function readRequest(operation, path, query = {}) {
  return {
    operation,
    method: "GET",
    path,
    query,
    body: null,
    normalizer: REDDIT_PROTOCOL_ROUTES[operation].normalizer,
    submission: "READ_ONLY",
    requiresWorkerModhash: false
  };
}

function writeRequest(operation, path, body) {
  return {
    operation,
    method: "POST",
    path,
    query: {},
    body,
    normalizer: REDDIT_PROTOCOL_ROUTES[operation].normalizer,
    submission: "SINGLE_ATTEMPT",
    requiresWorkerModhash: true
  };
}

function shortPostId(nativeId) {
  return nativeId.slice("t3_".length);
}

function shortMessageId(nativeId) {
  return nativeId.slice("t4_".length);
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
