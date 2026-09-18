import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  LedgerStore,
  HardenedWebhookTransport,
  MockRedditAdapter,
  SocialGitService,
  WebhookManager,
  bearerAuthenticator,
  createSocialGitHttpServer,
  isPublicWebhookAddress,
} from "../src/index.ts";
import { allScopes } from "./helpers.ts";

const key = Buffer.alloc(32, 7);

test("webhooks: secrets are encrypted, idempotent, tenant-scoped, and rotatable", () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, { tenantId: "tenant-a", encryptionKey: key });
  try {
    const created = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "create-1", url: "https://example.com/hooks/social-git",
      eventTypes: ["action.succeeded", "action.UNKNOWN"],
    });
    assert.equal(created.replayed, false);
    assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/u);
    const stored = store.db.prepare("SELECT secret_ciphertext FROM webhook_subscriptions WHERE id=?").get(created.subscription.id) as { secret_ciphertext: Uint8Array };
    assert.equal(Buffer.from(stored.secret_ciphertext).includes(Buffer.from(created.secret)), false);
    assert.equal(JSON.stringify(manager.listSubscriptions()).includes(created.secret), false);

    const replay = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "create-1", url: "https://example.com/hooks/social-git",
      eventTypes: ["action.succeeded", "action.UNKNOWN"],
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.secret, created.secret);
    assert.throws(() => manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "create-1", url: "https://example.com/different",
      eventTypes: ["action.succeeded"],
    }), /idempotency key/u);

    const rotated = manager.rotateSecret({ callerId: "owner-a", subscriptionId: created.subscription.id, idempotencyKey: "rotate-1" });
    assert.notEqual(rotated.secret, created.secret);
    assert.equal(rotated.subscription.signingKeyId, "v2");
    assert.equal(manager.rotateSecret({ callerId: "owner-a", subscriptionId: created.subscription.id, idempotencyKey: "rotate-1" }).secret, rotated.secret);

    const otherTenant = new WebhookManager(store, { tenantId: "tenant-b", encryptionKey: key });
    try { assert.deepEqual(otherTenant.listSubscriptions().items, []); }
    finally { otherTenant.close(); }
  } finally {
    manager.close();
    store.close();
  }
});

test("webhooks: delivery signs exact bytes, records attempts, and preserves event identity", async () => {
  const store = new LedgerStore(":memory:");
  const clock = Date.parse("2026-09-17T12:00:00.000Z");
  let received: { body: string; headers: Headers } | undefined;
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a", encryptionKey: key, now: () => clock,
    transport: { async send(_url, headers, body) {
      received = { body, headers: new Headers(headers) };
      return { status: 204 };
    } },
  });
  try {
    const created = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "create-signing", url: "https://example.com/events",
      eventTypes: ["action.succeeded"],
    });
    const event = manager.enqueue("action:one:succeeded", "action.succeeded", { actionId: "one", state: "succeeded" }, new Date(clock).toISOString());
    const delivered = await manager.deliverNext();
    assert.equal(delivered?.state, "delivered");
    assert.equal(delivered?.eventId, event.eventId);
    assert.equal(delivered?.attempts.length, 1);
    assert.ok(received);
    const timestamp = received.headers.get("x-social-git-timestamp")!;
    const expected = createHmac("sha256", Buffer.from(created.secret, "base64url"))
      .update(`${event.eventId}.${timestamp}.${received.body}`).digest("hex");
    assert.equal(received.headers.get("x-social-git-signature"), `v1=${expected}`);
    assert.equal(received.headers.get("x-social-git-event-id"), event.eventId);
    assert.equal(JSON.parse(received.body).version, 1);
    assert.equal((await manager.deliverNext()), null);
  } finally {
    manager.close();
    store.close();
  }
});

test("webhooks: retries only notification delivery with bounded backoff and fenced claims", async () => {
  const store = new LedgerStore(":memory:");
  let clock = Date.parse("2026-09-17T12:00:00.000Z");
  let calls = 0;
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a", encryptionKey: key, now: () => clock,
    transport: { async send() { calls += 1; return { status: 503 }; } },
  });
  try {
    const subscription = manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "create-retry", url: "https://example.com/events",
      eventTypes: ["action.failed"],
    }).subscription;
    manager.enqueue("action:two:failed", "action.failed", { actionId: "two", state: "failed" });
    let delivery = await manager.deliverNext();
    assert.equal(delivery?.state, "pending");
    assert.equal(await manager.deliverNext(), null);
    for (const delay of [5_000, 30_000, 300_000, 1_800_000]) {
      clock += delay;
      delivery = await manager.deliverNext();
    }
    assert.equal(calls, 5);
    assert.equal(delivery?.state, "exhausted");
    assert.equal(delivery?.attempts.length, 5);
    assert.equal(manager.listDeliveries({ subscriptionId: subscription.id }).items[0]?.state, "exhausted");
  } finally {
    manager.close();
    store.close();
  }
});

test("webhook transport rejects private DNS answers before any connection", async () => {
  let requests = 0;
  const transport = new HardenedWebhookTransport({
    resolve: async () => [{ address: "10.0.0.8", family: 4 }],
    request: async () => { requests += 1; return { status: 204 }; },
  });
  await assert.rejects(() => transport.send("https://receiver.example/hook", {}, "{}"), (error: any) => error.code === "DESTINATION_DENIED");
  assert.equal(requests, 0);
});

test("webhook transport pins the verified address across a DNS rebind", async () => {
  let resolutions = 0;
  let pinned = "";
  const transport = new HardenedWebhookTransport({
    resolve: async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    },
    request: async (input) => { pinned = input.address.address; return { status: 204 }; },
  });
  assert.equal((await transport.send("https://receiver.example/hook", {}, "{}")).status, 204);
  assert.equal(resolutions, 1);
  assert.equal(pinned, "93.184.216.34");
});

test("webhook transport deadline includes DNS resolution", async () => {
  const transport = new HardenedWebhookTransport({
    deadlineMs: 100,
    resolve: async () => await new Promise<never>(() => undefined),
    request: async () => { throw new Error("request must not start"); },
  });
  await assert.rejects(() => transport.send("https://receiver.example/hook", {}, "{}"), (error: any) => error.code === "TIMEOUT");
});

test("webhook transport denies metadata, reserved, and IPv4-mapped IPv6 destinations", async () => {
  const denied = [
    "169.254.169.254", "127.0.0.1", "100.64.0.1", "192.0.2.10",
    "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
    "2001::1", "2001:20::1", "2002::1", "3fff::1", "5f00::1",
    "fc00::1", "fe80::1", "ff02::1",
  ];
  for (const address of denied) {
    assert.equal(isPublicWebhookAddress(address), false, address);
  }
  let requests = 0;
  for (const address of denied) {
    const transport = new HardenedWebhookTransport({
      resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      request: async () => { requests += 1; return { status: 204 }; },
    });
    await assert.rejects(
      () => transport.send("https://receiver.example/hook", {}, "{}"),
      (error: any) => error.code === "DESTINATION_DENIED",
      address,
    );
  }
  assert.equal(requests, 0);
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, { tenantId: "tenant-a", encryptionKey: key });
  try {
    assert.throws(() => manager.createSubscription({
      callerId: "owner-a", idempotencyKey: "metadata", url: "https://169.254.169.254/latest/meta-data/",
      eventTypes: ["action.succeeded"],
    }), /non-public/u);
  } finally {
    manager.close();
    store.close();
  }
});

test("webhook redirects are recorded as permanent failures and never followed", async () => {
  let requests = 0;
  const transport = new HardenedWebhookTransport({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => { requests += 1; return { status: 302 }; },
  });
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, { tenantId: "tenant-a", encryptionKey: key, transport });
  try {
    manager.createSubscription({ callerId: "owner-a", idempotencyKey: "redirect", url: "https://receiver.example/hook", eventTypes: ["action.succeeded"] });
    manager.enqueue("action:redirect:succeeded", "action.succeeded", { actionId: "redirect" });
    const delivery = await manager.deliverNext();
    assert.equal(requests, 1);
    assert.equal(delivery?.state, "exhausted");
    assert.equal(delivery?.attempts[0]?.errorCode, "HTTP_302");
  } finally {
    manager.close();
    store.close();
  }
});

test("webhook completion rejects a stale delivery claim", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, {
    tenantId: "tenant-a", encryptionKey: key,
    transport: { async send() {
      store.db.prepare("UPDATE webhook_outbox SET claim_token='replacement-claim'").run();
      return { status: 204 };
    } },
  });
  try {
    manager.createSubscription({ callerId: "owner-a", idempotencyKey: "claim", url: "https://receiver.example/hook", eventTypes: ["action.succeeded"] });
    manager.enqueue("action:claim:succeeded", "action.succeeded", { actionId: "claim" });
    await assert.rejects(() => manager.deliverNext(), (error: any) => error.code === "ACTION_STATE_CONFLICT");
    const attempts = store.db.prepare("SELECT COUNT(*) AS count FROM webhook_delivery_attempts").get() as { count: number };
    assert.equal(Number(attempts.count), 0);
  } finally {
    manager.close();
    store.close();
  }
});

test("service: Reddit and X action lifecycle events share one tenant webhook outbox", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, { tenantId: "default", encryptionKey: key });
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()], webhooks: manager });
  const principal = { callerId: "owner-a", scopes: allScopes };
  try {
    await service.createWebhookSubscription(principal, {
      idempotencyKey: "service-hook", url: "https://example.com/events",
      eventTypes: ["action.queued", "action.succeeded"],
    });
    const account = (await service.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-1" })).account;
    await service.importConnection(principal, account.id, { vaultHandle: "vault://fixture/session", generation: 1 });
    const queued = await service.enqueueAction(principal, account.id, "write-one", { kind: "save", targetId: "post-1" });
    await service.runNextAction();
    const deliveries = await service.listWebhookDeliveries(principal, {});
    assert.deepEqual(deliveries.items.map((item) => item.eventType), ["action.queued", "action.succeeded"]);
    assert.equal(deliveries.items.every((item) => item.eventId && item.subscriptionId), true);
    assert.equal(queued.action.state, "queued");
  } finally {
    manager.close();
    store.close();
  }
});

test("REST and MCP share webhook operations, scopes, and idempotency headers", async () => {
  const store = new LedgerStore(":memory:");
  const manager = new WebhookManager(store, { tenantId: "default", encryptionKey: key });
  const service = new SocialGitService({ store, adapters: [new MockRedditAdapter()], webhooks: manager });
  const server = createSocialGitHttpServer({
    service,
    authenticate: bearerAuthenticator(new Map([["webhook-token", { callerId: "owner-a", scopes: allScopes }]])),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: "Bearer webhook-token", "content-type": "application/json", ...init.headers },
  });
  try {
    const create = await request("/v1/webhooks/subscriptions", {
      method: "POST", headers: { "idempotency-key": "rest-hook-1" },
      body: JSON.stringify({ url: "https://example.com/events", eventTypes: ["action.succeeded"] }),
    });
    assert.equal(create.status, 201);
    assert.equal(create.headers.get("idempotency-replayed"), "false");
    const body = await create.json() as any;
    assert.ok(body.secret);
    const replay = await request("/v1/webhooks/subscriptions", {
      method: "POST", headers: { "idempotency-key": "rest-hook-1" },
      body: JSON.stringify({ url: "https://example.com/events", eventTypes: ["action.succeeded"] }),
    });
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    const mcp = await request("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const tools = ((await mcp.json() as any).result.tools as Array<{ name: string }>).map(({ name }) => name);
    assert.ok(tools.includes("social_webhook_subscription_create"));
    assert.ok(tools.includes("x_action_create"));
  } finally {
    server.close();
    await once(server, "close");
    manager.close();
    store.close();
  }
});
