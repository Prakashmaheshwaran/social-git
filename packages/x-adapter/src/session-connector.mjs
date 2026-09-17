import { XContractError } from "./contract.mjs";

// Public web-client token recorded in the pinned source corpus. It is not an
// account credential and is never accepted from an API caller.
export const X_WEB_CLIENT_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export function createXSessionConnector({ authToken, csrfToken, userAgent = "social-git/0.1.0", profile = "api", transactionIdFor, wireConnector }) {
  const auth = secret(authToken, "auth_token", 8192);
  const csrf = secret(csrfToken, "ct0", 8192);
  const agent = header(userAgent, "user agent", 512);
  if (typeof wireConnector !== "function") throw invalid("A trusted X wire connector is required.");
  if (!new Set(["api", "home"]).has(profile)) throw invalid("The X header profile is invalid.");
  if (transactionIdFor !== undefined && typeof transactionIdFor !== "function") throw invalid("The X transaction provider is invalid.");
  const headers = Object.freeze({
    accept: profile === "home" ? "text/html" : "application/json",
    "accept-encoding": "identity",
    ...(profile === "home" ? {
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
    } : {
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
    }),
    authorization: `Bearer ${X_WEB_CLIENT_TOKEN}`,
    cookie: `auth_token=${auth}; ct0=${csrf}`,
    referer: "https://x.com/",
    "user-agent": agent,
    "x-csrf-token": csrf,
  });
  return async (request) => {
    if (!request || typeof request !== "object") throw invalid("The X egress request is invalid.");
    if (Object.hasOwn(request, "headers")) throw invalid("Caller-selected X headers are forbidden.");
    const framed = framedBody(request.body);
    let transactionId;
    if (transactionIdFor) {
      const url = new URL(request.url);
      transactionId = transactionIdFor(request.method, url.pathname);
      if (typeof transactionId !== "string" || transactionId.length < 16 || transactionId.length > 512 || !/^[A-Za-z0-9+/]+$/u.test(transactionId)) throw invalid("The generated X transaction ID is invalid.");
    }
    return wireConnector(Object.freeze({ ...request, body: framed.bytes, headers: Object.freeze({ ...headers, ...(framed.contentType ? { "content-type": framed.contentType } : {}), ...(transactionId ? { "x-client-transaction-id": transactionId } : {}) }) }));
  };
}

export function createXPublicAssetConnector({ userAgent = "social-git/0.1.0", wireConnector }) {
  const agent = header(userAgent, "user agent", 512);
  if (typeof wireConnector !== "function") throw invalid("A trusted X wire connector is required.");
  return async (request) => {
    if (!request || typeof request !== "object" || Object.hasOwn(request, "headers")) throw invalid("The X asset request is invalid.");
    const framed = framedBody(request.body);
    if (framed.contentType !== null || framed.bytes !== null || request.method !== "GET") throw invalid("The X asset request profile is invalid.");
    return wireConnector(Object.freeze({ ...request, body: null, headers: Object.freeze({ accept: "application/javascript", "accept-encoding": "identity", "user-agent": agent }) }));
  };
}

function framedBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(",") !== "bytes,contentType") throw invalid("The sealed X body framing is invalid.");
  if (value.bytes !== null && !(value.bytes instanceof Uint8Array)) throw invalid("The sealed X body bytes are invalid.");
  if (value.contentType !== null && (typeof value.contentType !== "string" || value.contentType.length < 1 || value.contentType.length > 256 || /[\r\n\0]/u.test(value.contentType))) throw invalid("The sealed X content type is invalid.");
  return value;
}

function secret(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[;\r\n\0]/u.test(value)) throw invalid(`Core must provide a valid ${label}.`);
  return value;
}
function header(value, label, maximum) { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) throw invalid(`Core must provide a valid ${label}.`); return value; }
function invalid(message) { return new XContractError("INVALID_REQUEST", message); }
