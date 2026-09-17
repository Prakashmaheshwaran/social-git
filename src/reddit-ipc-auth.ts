import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_REPLAY_ENTRIES = 10_000;

export const REDDIT_COMMAND_MAC_CONTEXT = Object.freeze({
  dispatchRequest: "request:POST:/v1/dispatch",
  readinessRequest: "request:GET:/readyz",
  response(status: number) {
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new TypeError("The Reddit command response status is invalid");
    return `response:${status}`;
  },
});

export interface RedditCommandMacHeaders {
  "x-social-git-command-timestamp": string;
  "x-social-git-command-nonce": string;
  "x-social-git-command-mac": string;
}

export function readRedditCommandKeyFile(path: string) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 256 || (stat.mode & 0o027) !== 0) throw new TypeError("The Reddit command key file must be a private bounded regular file");
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let encoded: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || (opened.mode & 0o027) !== 0) throw new TypeError("The Reddit command key file changed before it could be read");
    encoded = readFileSync(descriptor);
  } finally { closeSync(descriptor); }
  try {
    const text = encoded.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw new TypeError("The Reddit command key must be canonical base64url");
    const key = Buffer.from(text, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== text) { key.fill(0); throw new TypeError("The Reddit command key must contain exactly 32 bytes"); }
    return key;
  } finally { encoded.fill(0); }
}

export class RedditCommandMacSigner {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly nonce: () => Buffer;

  constructor(key: Uint8Array, options: { now?: () => number; nonce?: () => Buffer } = {}) {
    this.key = commandKey(key);
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(24));
  }

  headers(body: Uint8Array, context = ""): RedditCommandMacHeaders {
    const timestamp = String(this.now());
    if (!/^\d{13}$/u.test(timestamp)) throw new TypeError("The Reddit command timestamp is invalid");
    const nonceBytes = this.nonce();
    try {
      if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 24) throw new TypeError("The Reddit command nonce is invalid");
      const nonce = nonceBytes.toString("base64url");
      return {
        "x-social-git-command-timestamp": timestamp,
        "x-social-git-command-nonce": nonce,
        "x-social-git-command-mac": commandMac(this.key, timestamp, nonce, body, macContext(context)),
      };
    } finally { nonceBytes.fill(0); }
  }

  close() { this.key.fill(0); }
}

export class RedditCommandMacVerifier {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly used = new Map<string, number>();

  constructor(key: Uint8Array, options: { now?: () => number } = {}) {
    this.key = commandKey(key);
    this.now = options.now ?? Date.now;
  }

  verify(headers: Readonly<Record<string, string | string[] | undefined>>, body: Uint8Array, context = "") {
    const timestamp = one(headers["x-social-git-command-timestamp"]);
    const nonce = one(headers["x-social-git-command-nonce"]);
    const mac = one(headers["x-social-git-command-mac"]);
    if (!/^\d{13}$/u.test(timestamp) || !/^[A-Za-z0-9_-]{32}$/u.test(nonce) || !/^[a-f0-9]{64}$/u.test(mac)) return false;
    const timestampMs = Number(timestamp);
    const now = this.now();
    this.expire(now);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > MAX_CLOCK_SKEW_MS || this.used.has(nonce) || this.used.size >= MAX_REPLAY_ENTRIES) return false;
    const expected = Buffer.from(commandMac(this.key, timestamp, nonce, body, macContext(context)), "hex");
    const supplied = Buffer.from(mac, "hex");
    try {
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
      this.used.set(nonce, timestampMs);
      return true;
    } finally { expected.fill(0); supplied.fill(0); }
  }

  close() { this.key.fill(0); this.used.clear(); }

  private expire(now: number) {
    for (const [nonce, timestamp] of this.used) if (now - timestamp > MAX_CLOCK_SKEW_MS) this.used.delete(nonce);
  }
}

function commandMac(key: Uint8Array, timestamp: string, nonce: string, body: Uint8Array, context: string) {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", key).update(`social-git.reddit-command/v1\n${context}\n${timestamp}\n${nonce}\n${digest}`, "utf8").digest("hex");
}

function macContext(value: string) { if (typeof value !== "string" || value.length > 128 || /[\r\n\0]/u.test(value)) throw new TypeError("The Reddit command MAC context is invalid"); return value; }
function commandKey(value: Uint8Array) { if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw new TypeError("A distinct 32-byte Reddit command key is required"); return Buffer.from(value); }
function one(value: string | string[] | undefined) { return typeof value === "string" ? value : ""; }
