import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { assertPublicAddress } from "@social-git/worker-security";
import { ServiceError } from "./errors.ts";
import { canonicalJson, hashPayload, type LedgerStore } from "./persistence.ts";

export const WEBHOOK_EVENT_REGISTRY = Object.freeze([
  { type: "action.queued", description: "A Reddit or X mutation was durably queued." },
  { type: "action.succeeded", description: "A queued mutation reached a confirmed terminal success." },
  { type: "action.failed", description: "A queued mutation reached a terminal failure before confirmation." },
  { type: "action.action_required", description: "A queued mutation requires human platform action." },
  { type: "action.UNKNOWN", description: "A mutation may have been submitted but its result is unknown." },
  { type: "account.connected", description: "An account session generation was admitted." },
  { type: "account.revoked", description: "An account session was revoked." },
] as const);

export type WebhookEventType = (typeof WEBHOOK_EVENT_REGISTRY)[number]["type"];
const EVENT_TYPES = new Set<string>(WEBHOOK_EVENT_REGISTRY.map(({ type }) => type));
const RETRY_DELAYS_MS = [5_000, 30_000, 5 * 60_000, 30 * 60_000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const CLAIM_LEASE_MS = 30_000;

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  eventTypes: WebhookEventType[];
  signingKeyId: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  eventId: string;
  subscriptionId: string;
  eventType: string;
  occurredAt: string;
  state: "pending" | "delivered" | "exhausted";
  attemptCount: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  attempts: Array<{
    id: string;
    attemptNumber: number;
    attemptedAt: string;
    outcome: "delivered" | "retry_scheduled" | "exhausted";
    responseStatus: number | null;
    errorCode: string | null;
    nextAttemptAt: string | null;
  }>;
}

interface ClaimedDelivery {
  eventId: string;
  subscriptionId: string;
  url: string;
  eventType: string;
  occurredAt: string;
  payloadJson: string;
  claimToken: string;
  attemptNumber: number;
  secretCiphertext: Uint8Array;
  secretNonce: Uint8Array;
  secretTag: Uint8Array;
  secretGeneration: number;
}

export interface WebhookManagerOptions {
  tenantId: string;
  encryptionKey: Uint8Array;
  now?: () => number;
  transport?: WebhookTransport;
}

export interface ResolvedWebhookAddress { address: string; family: 4 | 6 }
export interface PinnedWebhookRequest {
  url: URL;
  address: ResolvedWebhookAddress;
  headers: Readonly<Record<string, string>>;
  body: string;
  deadlineMs: number;
  maxResponseBytes: number;
}
export interface WebhookTransport {
  send(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<{ status: number }>;
}

export class WebhookTransportError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class HardenedWebhookTransport implements WebhookTransport {
  private readonly resolve: (hostname: string) => Promise<readonly ResolvedWebhookAddress[]>;
  private readonly request: (input: PinnedWebhookRequest) => Promise<{ status: number }>;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: {
    resolve?: (hostname: string) => Promise<readonly ResolvedWebhookAddress[]>;
    request?: (input: PinnedWebhookRequest) => Promise<{ status: number }>;
    deadlineMs?: number;
    maxResponseBytes?: number;
  } = {}) {
    this.resolve = options.resolve ?? (async (hostname) => {
      try {
        return await dnsLookup(hostname, { all: true, verbatim: true }) as ResolvedWebhookAddress[];
      } catch {
        throw new WebhookTransportError("DNS_FAILED", "Webhook destination resolution failed.", true);
      }
    });
    this.request = options.request ?? pinnedHttpsRequest;
    this.deadlineMs = options.deadlineMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 100 || this.deadlineMs > 30_000) throw new TypeError("Webhook deadline is invalid");
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 0 || this.maxResponseBytes > 1024 * 1024) throw new TypeError("Webhook response cap is invalid");
  }

  async send(rawUrl: string, headers: Readonly<Record<string, string>>, body: string) {
    const startedAt = Date.now();
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new WebhookTransportError("DESTINATION_DENIED", "Webhook destination is not allowed.", false);
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await withinDeadline(this.resolve(hostname), this.deadlineMs);
    if (addresses.length < 1 || addresses.length > 32 || addresses.some(({ address, family }) => family !== isIP(address) || !isPublicWebhookAddress(address))) {
      throw new WebhookTransportError("DESTINATION_DENIED", "Webhook destination resolved outside the public Internet.", false);
    }
    // Resolve exactly once, then pin that verified address into the TLS socket.
    // Node's native HTTPS client ignores HTTP(S)_PROXY environment variables.
    const remainingMs = this.deadlineMs - (Date.now() - startedAt);
    if (remainingMs < 1) throw new WebhookTransportError("TIMEOUT", "Webhook request exceeded its deadline.", true);
    return this.request({
      url,
      address: addresses[0]!,
      headers,
      body,
      deadlineMs: remainingMs,
      maxResponseBytes: this.maxResponseBytes,
    });
  }
}

export class WebhookManager {
  private readonly db: DatabaseSync;
  private readonly tenantId: string;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly transport: WebhookTransport;

  constructor(store: LedgerStore, options: WebhookManagerOptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(options.tenantId)) throw new TypeError("tenantId is invalid");
    this.key = Buffer.from(options.encryptionKey);
    if (this.key.length !== 32) {
      this.key.fill(0);
      throw new TypeError("Webhook encryption key must contain exactly 32 bytes");
    }
    this.db = store.db;
    this.tenantId = options.tenantId;
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? new HardenedWebhookTransport();
  }

  close() { this.key.fill(0); }

  createSubscription(input: {
    callerId: string;
    idempotencyKey: string;
    url: unknown;
    eventTypes: unknown;
  }): { subscription: WebhookSubscription; secret: string; replayed: boolean } {
    const callerId = identifier(input.callerId, "callerId");
    const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey");
    const url = validateWebhookUrl(input.url);
    const eventTypes = validateEventTypes(input.eventTypes);
    const requestHash = hashPayload({ url, eventTypes });
    return this.transaction(() => {
      const replay = this.idempotency(callerId, "webhooks.subscriptions.create", idempotencyKey, requestHash);
      if (replay) {
        const row = this.subscriptionRow(replay.subscriptionId);
        if (Number(row.secret_generation) !== replay.secretGeneration) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotent webhook response is no longer available after secret rotation.");
        }
        return { subscription: rowToSubscription(row), secret: this.decryptSecret(row), replayed: true };
      }
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const encrypted = this.encryptSecret(id, 1, secret);
      const timestamp = this.timestamp();
      this.db.prepare(`INSERT INTO webhook_subscriptions(
        id, tenant_id, url, event_types_json, secret_ciphertext, secret_nonce, secret_tag,
        secret_generation, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`).run(
        id, this.tenantId, url, canonicalJson(eventTypes), encrypted.ciphertext, encrypted.nonce,
        encrypted.tag, timestamp, timestamp,
      );
      this.recordIdempotency(callerId, "webhooks.subscriptions.create", idempotencyKey, requestHash, id, 1);
      return { subscription: rowToSubscription(this.subscriptionRow(id)), secret, replayed: false };
    });
  }

  rotateSecret(input: { callerId: string; subscriptionId: string; idempotencyKey: string }) {
    const callerId = identifier(input.callerId, "callerId");
    const subscriptionId = identifier(input.subscriptionId, "subscriptionId");
    const idempotencyKey = boundedText(input.idempotencyKey, "idempotencyKey");
    const requestHash = hashPayload({ subscriptionId });
    return this.transaction(() => {
      const replay = this.idempotency(callerId, "webhooks.subscriptions.rotate", idempotencyKey, requestHash);
      if (replay) {
        const row = this.subscriptionRow(replay.subscriptionId);
        if (Number(row.secret_generation) !== replay.secretGeneration) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotent webhook response is no longer available after another rotation.");
        }
        return { subscription: rowToSubscription(row), secret: this.decryptSecret(row), replayed: true };
      }
      const row = this.subscriptionRow(subscriptionId);
      const generation = Number(row.secret_generation) + 1;
      const secret = randomBytes(32).toString("base64url");
      const encrypted = this.encryptSecret(subscriptionId, generation, secret);
      this.db.prepare(`UPDATE webhook_subscriptions SET secret_ciphertext=?, secret_nonce=?, secret_tag=?,
        secret_generation=?, updated_at=? WHERE id=? AND tenant_id=?`).run(
        encrypted.ciphertext, encrypted.nonce, encrypted.tag, generation, this.timestamp(), subscriptionId, this.tenantId,
      );
      this.recordIdempotency(callerId, "webhooks.subscriptions.rotate", idempotencyKey, requestHash, subscriptionId, generation);
      return { subscription: rowToSubscription(this.subscriptionRow(subscriptionId)), secret, replayed: false };
    });
  }

  disableSubscription(subscriptionId: string): { subscription: WebhookSubscription } {
    const id = identifier(subscriptionId, "subscriptionId");
    return this.transaction(() => {
      this.subscriptionRow(id);
      this.db.prepare("UPDATE webhook_subscriptions SET status='disabled', updated_at=? WHERE id=? AND tenant_id=?")
        .run(this.timestamp(), id, this.tenantId);
      this.db.prepare(`UPDATE webhook_outbox SET state='exhausted', claim_token=NULL, claim_expires_at=NULL,
        updated_at=? WHERE subscription_id=? AND state='pending'`).run(this.timestamp(), id);
      return { subscription: rowToSubscription(this.subscriptionRow(id)) };
    });
  }

  listSubscriptions(input: { cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(input.cursor);
    const limit = boundedLimit(input.limit);
    const rows = this.db.prepare(`SELECT rowid AS sequence, * FROM webhook_subscriptions
      WHERE tenant_id=? AND rowid>? ORDER BY rowid LIMIT ?`).all(this.tenantId, after, limit + 1) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      items: page.map(rowToSubscription),
      nextCursor: rows.length > limit ? encodeCursor(Number(page.at(-1)!.sequence)) : null,
    };
  }

  listDeliveries(input: { subscriptionId?: string; cursor?: string; limit?: number } = {}) {
    const after = decodeCursor(input.cursor);
    const limit = boundedLimit(input.limit);
    const subscriptionId = input.subscriptionId === undefined ? undefined : identifier(input.subscriptionId, "subscriptionId");
    if (subscriptionId) this.subscriptionRow(subscriptionId);
    const rows = (subscriptionId
      ? this.db.prepare(`SELECT o.rowid AS sequence, o.*, e.type, e.occurred_at FROM webhook_outbox o
          JOIN webhook_events e ON e.id=o.event_id WHERE e.tenant_id=? AND o.subscription_id=? AND o.rowid>?
          ORDER BY o.rowid LIMIT ?`).all(this.tenantId, subscriptionId, after, limit + 1)
      : this.db.prepare(`SELECT o.rowid AS sequence, o.*, e.type, e.occurred_at FROM webhook_outbox o
          JOIN webhook_events e ON e.id=o.event_id WHERE e.tenant_id=? AND o.rowid>?
          ORDER BY o.rowid LIMIT ?`).all(this.tenantId, after, limit + 1)) as Array<Record<string, unknown>>;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.rowToDelivery(row)),
      nextCursor: rows.length > limit ? encodeCursor(Number(page.at(-1)!.sequence)) : null,
    };
  }

  enqueue(sourceKey: string, type: WebhookEventType, payload: Record<string, unknown>, occurredAt = this.timestamp()) {
    identifier(sourceKey, "sourceKey", 256);
    if (!EVENT_TYPES.has(type)) throw new ServiceError("VALIDATION_FAILED", "Webhook event type is not registered.");
    const safePayload = JSON.parse(canonicalJson(payload)) as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(safePayload)) > 65_536) {
      throw new ServiceError("VALIDATION_FAILED", "Webhook event payload exceeds the 65536 byte limit.");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id, payload_json, type, occurred_at FROM webhook_events WHERE tenant_id=? AND source_key=?")
        .get(this.tenantId, sourceKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (String(existing.type) !== type || String(existing.payload_json) !== canonicalJson(safePayload)) {
          throw new ServiceError("IDEMPOTENCY_CONFLICT", "The webhook source key was already used with different content.");
        }
        this.fanOut(String(existing.id), type, String(existing.occurred_at));
        return { eventId: String(existing.id), replayed: true };
      }
      const eventId = randomUUID();
      const createdAt = this.timestamp();
      this.db.prepare(`INSERT INTO webhook_events(id, tenant_id, source_key, type, occurred_at, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(eventId, this.tenantId, sourceKey, type, occurredAt, canonicalJson(safePayload), createdAt);
      this.fanOut(eventId, type, occurredAt);
      return { eventId, replayed: false };
    });
  }

  reconcileDurableEvents() {
    const actions = this.db.prepare(`SELECT id, account_id, kind, state, submit_started_at, updated_at FROM actions
      WHERE state IN ('queued','succeeded','failed','action_required','UNKNOWN')`).all() as Array<Record<string, unknown>>;
    for (const action of actions) {
      const state = String(action.state);
      this.enqueue(`action:${action.id}:${state}`, `action.${state}` as WebhookEventType, {
        actionId: String(action.id), accountId: String(action.account_id), kind: String(action.kind), state,
        submissionMayHaveStarted: action.submit_started_at !== null,
      }, String(action.updated_at));
    }
    const connections = this.db.prepare("SELECT account_id, generation, status, connected_at, revoked_at FROM connections").all() as Array<Record<string, unknown>>;
    for (const connection of connections) {
      this.enqueue(`account:${connection.account_id}:connected:${connection.generation}`, "account.connected", {
        accountId: String(connection.account_id), generation: Number(connection.generation),
      }, String(connection.connected_at));
      if (connection.status === "revoked" && connection.revoked_at !== null) {
        this.enqueue(`account:${connection.account_id}:revoked:${connection.revoked_at}`, "account.revoked", {
          accountId: String(connection.account_id), generation: Number(connection.generation),
        }, String(connection.revoked_at));
      }
    }
    return { actions: actions.length, connections: connections.length };
  }

  async deliverNext(): Promise<WebhookDelivery | null> {
    const claimed = this.claimNext();
    if (!claimed) return null;
    const envelope = canonicalJson({
      version: 1,
      id: claimed.eventId,
      type: claimed.eventType,
      occurredAt: claimed.occurredAt,
      data: JSON.parse(claimed.payloadJson),
    });
    const timestamp = String(Math.floor(this.now() / 1000));
    let secret: Buffer | undefined;
    let responseStatus: number | null = null;
    try {
      secret = Buffer.from(this.decryptClaimedSecret(claimed), "base64url");
      const signature = createHmac("sha256", secret).update(`${claimed.eventId}.${timestamp}.${envelope}`).digest("hex");
      let response: { status: number };
      try {
        response = await this.transport.send(claimed.url, {
          "content-type": "application/json",
          "user-agent": "social-git-webhooks/1",
          "x-social-git-event-id": claimed.eventId,
          "x-social-git-timestamp": timestamp,
          "x-social-git-signature": `v1=${signature}`,
          "x-social-git-signing-key-id": `v${claimed.secretGeneration}`,
        }, envelope);
      } catch (error) {
        const errorCode = error instanceof WebhookTransportError ? error.code : "NETWORK_ERROR";
        return this.completeClaim(claimed, error instanceof WebhookTransportError && !error.retryable ? "exhausted" : "retry", null, errorCode);
      }
      responseStatus = response.status;
      if (response.status >= 200 && response.status < 300) return this.completeClaim(claimed, "delivered", responseStatus, null);
      return this.completeClaim(claimed, retryableStatus(response.status) ? "retry" : "exhausted", responseStatus, `HTTP_${response.status}`);
    } finally {
      secret?.fill(0);
    }
  }

  diagnostics() {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='exhausted' THEN 1 ELSE 0 END) AS exhausted
      FROM webhook_outbox o JOIN webhook_events e ON e.id=o.event_id WHERE e.tenant_id=?`).get(this.tenantId) as Record<string, unknown>;
    return { pending: Number(row.pending ?? 0), exhausted: Number(row.exhausted ?? 0) };
  }

  private claimNext(): ClaimedDelivery | null {
    return this.transaction(() => {
      const timestamp = this.timestamp();
      const row = this.db.prepare(`SELECT o.event_id, o.subscription_id, o.attempt_count,
          e.type, e.occurred_at, e.payload_json, s.url, s.secret_ciphertext, s.secret_nonce, s.secret_tag, s.secret_generation
        FROM webhook_outbox o JOIN webhook_events e ON e.id=o.event_id
        JOIN webhook_subscriptions s ON s.id=o.subscription_id
        WHERE e.tenant_id=? AND s.status='active' AND o.state='pending' AND o.next_attempt_at<=?
          AND (o.claim_token IS NULL OR o.claim_expires_at<=?)
        ORDER BY o.next_attempt_at, e.created_at LIMIT 1`).get(this.tenantId, timestamp, timestamp) as Record<string, unknown> | undefined;
      if (!row) return null;
      const claimToken = randomUUID();
      const expiresAt = new Date(this.now() + CLAIM_LEASE_MS).toISOString();
      const updated = this.db.prepare(`UPDATE webhook_outbox SET claim_token=?, claim_expires_at=?,
        attempt_count=attempt_count+1, updated_at=? WHERE event_id=? AND subscription_id=? AND state='pending'
        AND (claim_token IS NULL OR claim_expires_at<=?)`).run(
        claimToken, expiresAt, timestamp, String(row.event_id), String(row.subscription_id), timestamp,
      );
      if (Number(updated.changes) !== 1) return null;
      return {
        eventId: String(row.event_id), subscriptionId: String(row.subscription_id), url: String(row.url),
        eventType: String(row.type), occurredAt: String(row.occurred_at), payloadJson: String(row.payload_json),
        claimToken, attemptNumber: Number(row.attempt_count) + 1,
        secretCiphertext: row.secret_ciphertext as Uint8Array, secretNonce: row.secret_nonce as Uint8Array,
        secretTag: row.secret_tag as Uint8Array, secretGeneration: Number(row.secret_generation),
      };
    });
  }

  private completeClaim(claim: ClaimedDelivery, result: "delivered" | "retry" | "exhausted", responseStatus: number | null, errorCode: string | null) {
    return this.transaction(() => {
      const timestamp = this.timestamp();
      const retry = result === "retry" && claim.attemptNumber < MAX_ATTEMPTS;
      const outcome = result === "delivered" ? "delivered" : retry ? "retry_scheduled" : "exhausted";
      const nextAttemptAt = retry ? new Date(this.now() + RETRY_DELAYS_MS[claim.attemptNumber - 1]!).toISOString() : null;
      const state = result === "delivered" ? "delivered" : retry ? "pending" : "exhausted";
      const updated = this.db.prepare(`UPDATE webhook_outbox SET state=?, next_attempt_at=COALESCE(?, next_attempt_at),
        claim_token=NULL, claim_expires_at=NULL, delivered_at=?, updated_at=?
        WHERE event_id=? AND subscription_id=? AND state='pending' AND claim_token=?`).run(
        state, nextAttemptAt, result === "delivered" ? timestamp : null, timestamp,
        claim.eventId, claim.subscriptionId, claim.claimToken,
      );
      if (Number(updated.changes) !== 1) throw new ServiceError("ACTION_STATE_CONFLICT", "The webhook delivery claim is stale.");
      this.db.prepare(`INSERT INTO webhook_delivery_attempts(
        id, event_id, subscription_id, attempt_number, attempted_at, outcome, response_status, error_code, next_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(), claim.eventId, claim.subscriptionId, claim.attemptNumber, timestamp, outcome,
        responseStatus, errorCode, nextAttemptAt,
      );
      const row = this.db.prepare(`SELECT o.*, e.type, e.occurred_at FROM webhook_outbox o
        JOIN webhook_events e ON e.id=o.event_id WHERE o.event_id=? AND o.subscription_id=?`).get(
        claim.eventId, claim.subscriptionId,
      ) as Record<string, unknown>;
      return this.rowToDelivery(row);
    });
  }

  private rowToDelivery(row: Record<string, unknown>): WebhookDelivery {
    const attempts = this.db.prepare(`SELECT * FROM webhook_delivery_attempts WHERE event_id=? AND subscription_id=?
      ORDER BY attempt_number`).all(String(row.event_id), String(row.subscription_id)) as Array<Record<string, unknown>>;
    return {
      eventId: String(row.event_id), subscriptionId: String(row.subscription_id), eventType: String(row.type),
      occurredAt: String(row.occurred_at), state: row.state as WebhookDelivery["state"],
      attemptCount: Number(row.attempt_count), nextAttemptAt: String(row.next_attempt_at),
      deliveredAt: row.delivered_at === null ? null : String(row.delivered_at),
      attempts: attempts.map((attempt) => ({
        id: String(attempt.id), attemptNumber: Number(attempt.attempt_number), attemptedAt: String(attempt.attempted_at),
        outcome: attempt.outcome as WebhookDelivery["attempts"][number]["outcome"],
        responseStatus: attempt.response_status === null ? null : Number(attempt.response_status),
        errorCode: attempt.error_code === null ? null : String(attempt.error_code),
        nextAttemptAt: attempt.next_attempt_at === null ? null : String(attempt.next_attempt_at),
      })),
    };
  }

  private fanOut(eventId: string, type: WebhookEventType, occurredAt: string) {
    const subscriptions = this.db.prepare(`SELECT id, event_types_json FROM webhook_subscriptions
      WHERE tenant_id=? AND status='active' AND created_at<=?`).all(this.tenantId, occurredAt) as Array<Record<string, unknown>>;
    const queuedAt = this.timestamp();
    for (const subscription of subscriptions) {
      if (!(JSON.parse(String(subscription.event_types_json)) as string[]).includes(type)) continue;
      this.db.prepare(`INSERT OR IGNORE INTO webhook_outbox(event_id, subscription_id, state, next_attempt_at, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`).run(eventId, String(subscription.id), queuedAt, queuedAt);
    }
  }

  private subscriptionRow(id: string) {
    const row = this.db.prepare("SELECT * FROM webhook_subscriptions WHERE id=? AND tenant_id=?")
      .get(id, this.tenantId) as Record<string, unknown> | undefined;
    if (!row) throw new ServiceError("NOT_FOUND", "Webhook subscription not found.");
    return row;
  }

  private encryptSecret(subscriptionId: string, generation: number, secret: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.tenantId}:${subscriptionId}:${generation}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { ciphertext, nonce, tag: cipher.getAuthTag() };
  }

  private decryptSecret(row: Record<string, unknown>) {
    return this.decrypt(
      String(row.id), Number(row.secret_generation), row.secret_ciphertext as Uint8Array,
      row.secret_nonce as Uint8Array, row.secret_tag as Uint8Array,
    );
  }

  private decryptClaimedSecret(claim: ClaimedDelivery) {
    return this.decrypt(claim.subscriptionId, claim.secretGeneration, claim.secretCiphertext, claim.secretNonce, claim.secretTag);
  }

  private decrypt(subscriptionId: string, generation: number, ciphertext: Uint8Array, nonce: Uint8Array, tag: Uint8Array) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(`${this.tenantId}:${subscriptionId}:${generation}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tag));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  private idempotency(callerId: string, operationId: string, key: string, requestHash: string) {
    const row = this.db.prepare(`SELECT request_hash, subscription_id, secret_generation FROM webhook_idempotency
      WHERE tenant_id=? AND caller_id=? AND operation_id=? AND idempotency_key=?`).get(
      this.tenantId, callerId, operationId, key,
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (String(row.request_hash) !== requestHash) throw new ServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different request.");
    return { subscriptionId: String(row.subscription_id), secretGeneration: Number(row.secret_generation) };
  }

  private recordIdempotency(callerId: string, operationId: string, key: string, requestHash: string, subscriptionId: string, generation: number) {
    this.db.prepare(`INSERT INTO webhook_idempotency(
      tenant_id, caller_id, operation_id, idempotency_key, request_hash, subscription_id, secret_generation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.tenantId, callerId, operationId, key, requestHash, subscriptionId, generation, this.timestamp(),
    );
  }

  private timestamp() { return new Date(this.now()).toISOString(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class WebhookDeliveryWorker {
  private readonly manager: WebhookManager;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(manager: WebhookManager, intervalMs = 1_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 25 || intervalMs > 60_000) throw new TypeError("Webhook worker interval is invalid");
    this.manager = manager;
    this.intervalMs = intervalMs;
  }

  start() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.wake(), this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.stopped || this.running) return;
    this.running = this.manager.deliverNext().then(() => undefined, () => undefined).finally(() => { this.running = null; });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

function rowToSubscription(row: Record<string, unknown>): WebhookSubscription {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), url: String(row.url),
    eventTypes: JSON.parse(String(row.event_types_json)) as WebhookEventType[],
    signingKeyId: `v${Number(row.secret_generation)}`,
    status: row.status as WebhookSubscription["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function validateWebhookUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) throw new ServiceError("VALIDATION_FAILED", "url is invalid.", { details: { field: "url" } });
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError("VALIDATION_FAILED", "url must be absolute.", { details: { field: "url" } }); }
  if (url.protocol !== "https:") {
    throw new ServiceError("VALIDATION_FAILED", "Webhook URLs must use HTTPS.", { details: { field: "url" } });
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.username || url.password || url.hash || (isIP(hostname) !== 0 && !isPublicWebhookAddress(hostname))) {
    throw new ServiceError("VALIDATION_FAILED", "Webhook URL credentials, fragments, and non-public addresses are not allowed.", { details: { field: "url" } });
  }
  return url.toString();
}

export function isPublicWebhookAddress(address: string) {
  try {
    assertPublicAddress(address);
    return true;
  } catch {
    return false;
  }
}

function pinnedHttpsRequest(input: PinnedWebhookRequest): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const fail = (error: WebhookTransportError) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(error);
    };
    const request = httpsRequest(input.url, {
      method: "POST",
      agent: false,
      headers: { ...input.headers, "content-length": String(Buffer.byteLength(input.body)) },
      lookup: (_hostname, _options, callback) => callback(null, input.address.address, input.address.family),
    }, (response) => {
      let bytes = 0;
      const declaredLength = Number(response.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > input.maxResponseBytes) {
        response.destroy();
        request.destroy();
        fail(new WebhookTransportError("RESPONSE_TOO_LARGE", "Webhook response exceeded the byte limit.", false));
        return;
      }
      response.on("data", (chunk: Uint8Array) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxResponseBytes) {
          response.destroy();
          request.destroy();
          fail(new WebhookTransportError("RESPONSE_TOO_LARGE", "Webhook response exceeded the byte limit.", false));
        }
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ status: response.statusCode ?? 502 });
      });
      response.on("error", () => fail(new WebhookTransportError("NETWORK_ERROR", "Webhook response failed.", true)));
    });
    request.on("error", () => fail(new WebhookTransportError("NETWORK_ERROR", "Webhook request failed.", true)));
    deadline = setTimeout(() => {
      request.destroy();
      fail(new WebhookTransportError("TIMEOUT", "Webhook request exceeded its deadline.", true));
    }, input.deadlineMs);
    request.end(input.body);
  });
}

function withinDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WebhookTransportError("TIMEOUT", "Webhook destination resolution exceeded its deadline.", true)), deadlineMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error instanceof WebhookTransportError ? error : new WebhookTransportError("DNS_FAILED", "Webhook destination resolution failed.", true)); },
    );
  });
}

function validateEventTypes(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WEBHOOK_EVENT_REGISTRY.length ||
    value.some((type) => typeof type !== "string" || !EVENT_TYPES.has(type))) {
    throw new ServiceError("VALIDATION_FAILED", "eventTypes must be a non-empty array of registered event types.", { details: { field: "eventTypes" } });
  }
  const unique = [...new Set(value as WebhookEventType[])].sort();
  if (unique.length !== value.length) throw new ServiceError("VALIDATION_FAILED", "eventTypes must not contain duplicates.", { details: { field: "eventTypes" } });
  return unique;
}

function identifier(value: unknown, field: string, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw new ServiceError("VALIDATION_FAILED", `${field} is invalid.`, { details: { field } });
  }
  return value;
}

function boundedText(value: unknown, field: string, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new ServiceError("VALIDATION_FAILED", `${field} is invalid.`, { details: { field } });
  }
  return value;
}

function boundedLimit(value: number | undefined) {
  const limit = value ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ServiceError("VALIDATION_FAILED", "limit must be an integer from 1 through 100.");
  return limit;
}

function encodeCursor(sequence: number) { return Buffer.from(JSON.stringify({ v: 1, sequence })).toString("base64url"); }
function decodeCursor(value?: string) {
  if (!value) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (decoded.v !== 1 || !Number.isSafeInteger(decoded.sequence) || decoded.sequence < 0) throw new Error();
    return Number(decoded.sequence);
  } catch { throw new ServiceError("VALIDATION_FAILED", "cursor is invalid.", { details: { field: "cursor" } }); }
}

function retryableStatus(status: number) { return status === 408 || status === 425 || status === 429 || status >= 500; }

export function deriveWebhookEncryptionKey(masterKey: Uint8Array) {
  if (masterKey.byteLength !== 32) throw new TypeError("Master key must contain exactly 32 bytes");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "social-git:webhook-secrets:v1", 32));
}
