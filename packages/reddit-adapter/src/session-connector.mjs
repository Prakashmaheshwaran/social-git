import { createPinnedHttpsConnector } from "../../worker-security/src/index.mjs";
import { AdapterContractError, CORE_ERROR_CODES } from "./contract.mjs";

const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * Build the Core-side connector for one Reddit session generation.
 *
 * The returned closure is installed under one server-owned route connector ID.
 * Session cookies and the CSRF/modhash value never enter a route descriptor or
 * worker message. The connector has no retry loop and ignores proxy environment
 * variables because the underlying connector dials the broker-selected address.
 */
export function createRedditSessionConnector({
  cookies,
  csrfToken,
  userAgent = "social-git/0.1.0",
  wireConnector
}) {
  const cookieHeader = serializeCookies(cookies);
  const modhash = requireSecretText(csrfToken, "CSRF token", 4096);
  const agent = requireHeaderValue(userAgent, "user agent", 512);
  const headers = Object.freeze({
    accept: "application/json",
    "accept-encoding": "identity",
    "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    cookie: cookieHeader,
    "user-agent": agent,
    "x-modhash": modhash
  });
  const pinned = wireConnector
    ? (request) => wireConnector(Object.freeze({ ...request, headers }))
    : createPinnedHttpsConnector({ headers });

  return async (request) => {
    if (!request || typeof request !== "object") {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The Core egress request is invalid");
    }
    if (request.method !== "POST") return pinned(request);
    if (!(request.body instanceof Uint8Array)) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "A Reddit write requires a form body");
    }

    const body = appendModhash(request.body, modhash);
    try {
      return await pinned(Object.freeze({ ...request, body }));
    } finally {
      body.fill(0);
    }
  };
}

function serializeCookies(cookies) {
  if (!cookies || typeof cookies !== "object" || Array.isArray(cookies) || Object.getPrototypeOf(cookies) !== Object.prototype) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "Core must provide a plain Reddit cookie map");
  }
  const entries = Object.entries(cookies).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1 || entries.length > 64) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The Reddit cookie map is empty or too large");
  }
  const pairs = entries.map(([name, value]) => {
    if (!COOKIE_NAME.test(name) || typeof value !== "string" || value.length < 1 || value.length > 8192 || /[;\r\n\0]/u.test(value)) {
      throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The Reddit cookie map contains an invalid value");
    }
    return `${name}=${value}`;
  });
  const header = pairs.join("; ");
  if (Buffer.byteLength(header, "utf8") > 16 * 1024) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "The Reddit cookie header exceeds its byte bound");
  }
  return header;
}

function appendModhash(body, modhash) {
  const form = new URLSearchParams(Buffer.from(body).toString("utf8"));
  if (form.has("uh")) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, "A protocol request cannot override the Core CSRF value");
  }
  form.set("uh", modhash);
  return Buffer.from(form.toString(), "utf8");
}

function requireSecretText(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new AdapterContractError(CORE_ERROR_CODES.INVALID_REQUEST, `Core must provide a valid ${label}`);
  }
  return value;
}

function requireHeaderValue(value, label, maximum) {
  return requireSecretText(value, label, maximum);
}
