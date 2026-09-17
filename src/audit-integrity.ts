import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_GENESIS_MAC = "0".repeat(64);
export const DEVELOPMENT_AUDIT_KEY = createHash("sha256")
  .update("social-git:development-only:audit-chain-key:v1", "utf8")
  .digest();

export interface AuditChainHead {
  version: 1;
  stream: string;
  context: string;
  sequence: number;
  eventId: string | null;
  mac: string;
}

export interface AuditChainEntry {
  sequence: number;
  eventId: string;
  previousMac: string;
  eventMac: string;
  payload: unknown;
}

export function canonicalAuditJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalAuditJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requireAuditKey(value: Uint8Array | undefined): Buffer {
  const key = Buffer.from(value ?? DEVELOPMENT_AUDIT_KEY);
  if (key.byteLength !== 32) {
    key.fill(0);
    throw new TypeError("Audit integrity key must contain exactly 32 bytes");
  }
  return key;
}

export function computeAuditMac(input: {
  key: Uint8Array;
  stream: string;
  context: string;
  sequence: number;
  eventId: string;
  previousMac: string;
  payload: unknown;
}): string {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new TypeError("Audit sequence is invalid");
  if (!/^[a-f0-9]{64}$/u.test(input.previousMac)) throw new TypeError("Previous audit MAC is invalid");
  return createHmac("sha256", input.key).update(canonicalAuditJson({
    version: AUDIT_CHAIN_VERSION,
    stream: input.stream,
    context: input.context,
    sequence: input.sequence,
    eventId: input.eventId,
    previousMac: input.previousMac,
    payload: input.payload,
  }), "utf8").digest("hex");
}

export function verifyAuditChain(input: {
  key: Uint8Array;
  stream: string;
  context: string;
  entries: readonly AuditChainEntry[];
  storedHead?: AuditChainHead | null;
  expectedHead?: AuditChainHead | null;
}): AuditChainHead {
  if (input.expectedHead && (
    input.expectedHead.version !== AUDIT_CHAIN_VERSION
    || input.expectedHead.stream !== input.stream
    || input.expectedHead.context !== input.context
    || input.expectedHead.sequence < 0
  )) throw new Error(`Audit chain ${input.stream} expected head is invalid`);
  let previousMac = AUDIT_GENESIS_MAC;
  let previousSequence = 0;
  let eventId: string | null = null;
  for (const entry of input.entries) {
    if (entry.sequence !== previousSequence + 1 || entry.previousMac !== previousMac) {
      throw new Error(`Audit chain ${input.stream} is truncated, reordered, or discontinuous`);
    }
    const expected = computeAuditMac({ ...input, sequence: entry.sequence, eventId: entry.eventId, previousMac, payload: entry.payload });
    if (!safeEqualHex(entry.eventMac, expected)) throw new Error(`Audit chain ${input.stream} authentication failed`);
    previousSequence = entry.sequence;
    previousMac = entry.eventMac;
    eventId = entry.eventId;
    if (input.expectedHead?.sequence === previousSequence && !sameHead({
      version: AUDIT_CHAIN_VERSION,
      stream: input.stream,
      context: input.context,
      sequence: previousSequence,
      eventId,
      mac: previousMac,
    }, input.expectedHead)) throw new Error(`Audit chain ${input.stream} does not extend the externally retained head`);
  }
  const head: AuditChainHead = {
    version: AUDIT_CHAIN_VERSION,
    stream: input.stream,
    context: input.context,
    sequence: previousSequence,
    eventId,
    mac: previousMac,
  };
  if (input.storedHead && !sameHead(head, input.storedHead)) throw new Error(`Audit chain ${input.stream} head does not match its records`);
  if (input.expectedHead?.sequence === 0 && !sameHead({ ...head, sequence: 0, eventId: null, mac: AUDIT_GENESIS_MAC }, input.expectedHead)) {
    throw new Error(`Audit chain ${input.stream} does not extend the externally retained head`);
  }
  if (input.expectedHead && input.expectedHead.sequence > head.sequence) throw new Error(`Audit chain ${input.stream} is behind the externally retained head`);
  return Object.freeze(head);
}

export function sameHead(left: AuditChainHead, right: AuditChainHead): boolean {
  return left.version === right.version
    && left.stream === right.stream
    && left.context === right.context
    && left.sequence === right.sequence
    && left.eventId === right.eventId
    && safeEqualHex(left.mac, right.mac);
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
