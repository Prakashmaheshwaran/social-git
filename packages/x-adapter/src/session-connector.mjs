import { XContractError } from "./contract.mjs";

// Public web-client token recorded in the pinned source corpus. It is not an
// account credential and is never accepted from an API caller.
const WEB_CLIENT_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

export function createXSessionConnector({ authToken, csrfToken, userAgent = "social-git/0.1.0", transactionIdFor, wireConnector }) {
  const auth = secret(authToken, "auth_token", 8192);
  const csrf = secret(csrfToken, "ct0", 8192);
  const agent = header(userAgent, "user agent", 512);
  if (typeof wireConnector !== "function") throw invalid("A trusted X wire connector is required.");
  if (transactionIdFor !== undefined && typeof transactionIdFor !== "function") throw invalid("The X transaction provider is invalid.");
  const headers = Object.freeze({
    accept: "application/json",
    "accept-encoding": "identity",
    authorization: `Bearer ${WEB_CLIENT_TOKEN}`,
    cookie: `auth_token=${auth}; ct0=${csrf}`,
    "user-agent": agent,
    "x-csrf-token": csrf,
    "x-twitter-active-user": "yes",
  });
  return async (request) => {
    if (!request || typeof request !== "object") throw invalid("The X egress request is invalid.");
    let transactionId;
    if (transactionIdFor) {
      const url = new URL(request.url);
      transactionId = transactionIdFor(request.method, url.pathname);
      if (typeof transactionId !== "string" || transactionId.length < 16 || transactionId.length > 512 || !/^[A-Za-z0-9+/]+$/u.test(transactionId)) throw invalid("The generated X transaction ID is invalid.");
    }
    return wireConnector(Object.freeze({ ...request, headers: Object.freeze({ ...headers, ...(transactionId ? { "x-client-transaction-id": transactionId } : {}) }) }));
  };
}

function secret(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[;\r\n\0]/u.test(value)) throw invalid(`Core must provide a valid ${label}.`);
  return value;
}
function header(value, label, maximum) { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) throw invalid(`Core must provide a valid ${label}.`); return value; }
function invalid(message) { return new XContractError("INVALID_REQUEST", message); }
