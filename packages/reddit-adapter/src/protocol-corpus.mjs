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
    }
  ]
});

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
  "item.deleteOwn": {
    method: "POST",
    pathTemplate: "/api/del",
    normalizer: "deleted_item",
    submission: "SINGLE_ATTEMPT"
  }
});

export function buildRedditProtocolRequest(operation, input) {
  const capability = assertSupportedOperation(operation);
  if (capability.protocolMapping !== PROTOCOL_MAPPING_STATUS.MAPPED) {
    throw new AdapterContractError(
      CORE_ERROR_CODES.CAPABILITY_DISABLED,
      `Reddit operation ${operation} has no admitted protocol mapping`
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
        ...(validatedInput.subreddit ? { t: "day" } : {}),
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
        sort: "best",
        limit: validatedInput.limit ?? 50,
        raw_json: 1
      }));
      break;
    case "search.query": {
      const path = validatedInput.subreddit
        ? `/r/${validatedInput.subreddit}/search.json`
        : "/search.json";
      request = readRequest(operation, path, compact({
        q: validatedInput.query,
        sort: "relevance",
        t: "all",
        limit: validatedInput.limit ?? 25,
        raw_json: 1,
        type: "link",
        ...(validatedInput.subreddit ? { restrict_sr: "on" } : {})
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
