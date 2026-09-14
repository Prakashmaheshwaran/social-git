import { createHmac, timingSafeEqual } from "node:crypto";
import { requireValue, runtimeError } from "./errors.js";

const ZERO_MAC = Buffer.alloc(32);
const EVENT_SCHEMAS = Object.freeze({
  "session.imported": Object.freeze({}),
  "session.rotated": Object.freeze({}),
  "account.revoked": Object.freeze({}),
  "worker.completed": Object.freeze({ status: "text" }),
  "worker.interrupted": Object.freeze({ reason: "text", resultStatus: "nullableText" }),
  "master_key.rotated": Object.freeze({ accountCount: "nonNegativeInteger" }),
  "database.checkpointed": Object.freeze({
    busy: "nonNegativeInteger",
    logFrames: "nonNegativeInteger",
    checkpointedFrames: "nonNegativeInteger"
  }),
  "backup.created": Object.freeze({ backupId: "text", expiresAt: "nonNegativeInteger" })
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validText(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validateDetails(eventType, details) {
  const schema = EVENT_SCHEMAS[eventType];
  requireValue(schema !== undefined && isPlainObject(details));
  const expectedKeys = Object.keys(schema);
  requireValue(Object.keys(details).length === expectedKeys.length);
  const result = {};
  for (const key of expectedKeys) {
    requireValue(Object.hasOwn(details, key));
    const value = details[key];
    switch (schema[key]) {
      case "text":
        requireValue(validText(value));
        break;
      case "nullableText":
        requireValue(value === null || validText(value));
        break;
      case "nonNegativeInteger":
        requireValue(Number.isSafeInteger(value) && value >= 0);
        break;
      default:
        throw runtimeError("INVALID_ARGUMENT");
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function eventBytes(event, previousMac) {
  return Buffer.from(JSON.stringify({
    version: 1,
    sequence: event.sequence,
    tenantId: event.tenantId,
    eventType: event.eventType,
    accountId: event.accountId,
    generation: event.generation,
    occurredAt: event.occurredAt,
    details: event.details,
    previousMac: previousMac.toString("base64url")
  }), "utf8");
}

function computeMac(key, event, previousMac) {
  const bytes = eventBytes(event, previousMac);
  try {
    return createHmac("sha256", key).update(bytes).digest();
  } finally {
    bytes.fill(0);
  }
}

function rowToEvent(row) {
  let details;
  try {
    details = JSON.parse(row.details_json);
  } catch {
    throw runtimeError("AUDIT_INTEGRITY_FAILURE");
  }
  try {
    details = validateDetails(row.event_type, details);
  } catch {
    throw runtimeError("AUDIT_INTEGRITY_FAILURE");
  }
  if (!Number.isSafeInteger(row.sequence)
    || row.sequence < 1
    || !validText(row.tenant_id)
    || (row.account_id !== null && !validText(row.account_id))
    || (row.generation !== null
      && (!Number.isSafeInteger(row.generation) || row.generation < 1))
    || !Number.isSafeInteger(row.occurred_at)
    || row.occurred_at < 0
    || !(row.previous_mac instanceof Uint8Array)
    || row.previous_mac.byteLength !== 32
    || !(row.event_mac instanceof Uint8Array)
    || row.event_mac.byteLength !== 32) {
    throw runtimeError("AUDIT_INTEGRITY_FAILURE");
  }
  return {
    sequence: row.sequence,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    accountId: row.account_id,
    generation: row.generation,
    occurredAt: row.occurred_at,
    details
  };
}

export class AuditLedger {
  #key;
  #store;
  #tenantId;

  constructor({ auditKey, store, tenantId }) {
    requireValue(auditKey instanceof Uint8Array && auditKey.byteLength === 32);
    requireValue(store !== null && typeof store === "object");
    requireValue(validText(tenantId));
    this.#key = Buffer.from(auditKey);
    this.#store = store;
    this.#tenantId = tenantId;
  }

  append({ eventType, accountId = null, generation = null, occurredAt, details = {} }) {
    requireValue(Object.hasOwn(EVENT_SCHEMAS, eventType));
    requireValue(accountId === null || validText(accountId));
    requireValue(generation === null || (Number.isSafeInteger(generation) && generation > 0));
    requireValue(Number.isSafeInteger(occurredAt) && occurredAt >= 0);
    const validDetails = validateDetails(eventType, details);
    const head = this.#store.getAuditHead(this.#tenantId);
    const previousMac = head === undefined ? Buffer.from(ZERO_MAC) : Buffer.from(head.event_mac);
    const sequence = head === undefined ? 1 : head.sequence + 1;
    const event = {
      sequence,
      tenantId: this.#tenantId,
      eventType,
      accountId,
      generation,
      occurredAt,
      details: validDetails
    };
    const eventMac = computeMac(this.#key, event, previousMac);
    try {
      this.#store.insertAuditEvent({
        ...event,
        detailsJson: JSON.stringify(validDetails),
        previousMac,
        eventMac
      });
    } finally {
      previousMac.fill(0);
      eventMac.fill(0);
    }
    return Object.freeze({ ...event });
  }

  verify() {
    const rows = this.#store.getAuditEvents(this.#tenantId);
    let previousMac = Buffer.from(ZERO_MAC);
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const event = rowToEvent(row);
        if (event.tenantId !== this.#tenantId
          || event.sequence !== index + 1
          || !timingSafeEqual(Buffer.from(row.previous_mac), previousMac)) {
          throw runtimeError("AUDIT_INTEGRITY_FAILURE");
        }
        const expectedMac = computeMac(this.#key, event, previousMac);
        const actualMac = Buffer.from(row.event_mac);
        const matches = timingSafeEqual(actualMac, expectedMac);
        previousMac.fill(0);
        previousMac = Buffer.from(actualMac);
        expectedMac.fill(0);
        actualMac.fill(0);
        if (!matches) throw runtimeError("AUDIT_INTEGRITY_FAILURE");
      }
      return Object.freeze({ eventCount: rows.length });
    } finally {
      previousMac.fill(0);
    }
  }

  list() {
    this.verify();
    return Object.freeze(this.#store.getAuditEvents(this.#tenantId).map((row) => {
      const event = rowToEvent(row);
      return Object.freeze({ ...event });
    }));
  }

  close() {
    this.#key.fill(0);
  }
}

export const AUDIT_EVENT_TYPES = Object.freeze(Object.keys(EVENT_SCHEMAS));
