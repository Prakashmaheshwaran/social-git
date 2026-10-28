import assert from "node:assert/strict";
import test from "node:test";

import {
  isMediaWriteKind,
  LedgerStore,
  MockRedditAdapter,
  platformForReadKind,
  platformForWriteKind,
  READ_KIND_PLATFORM,
  ServiceError,
  SocialGitService,
  WRITE_KIND_REGISTRY,
  WRITE_KINDS,
  XFixturePlatformAdapter,
} from "../src/index.ts";
import { fixture, principal } from "./helpers.ts";

/**
 * The write-kind -> platform registry replaces the `x_` spelling convention.
 * These tests pin the three properties that convention could not guarantee:
 * exhaustive coverage, a correct per-platform mapping, and fail-closed
 * behaviour for a kind that is not registered at all.
 */

test("write-kind registry: every WRITE_KIND has exactly one entry and no strays", () => {
  const registered = Object.keys(WRITE_KIND_REGISTRY).sort();
  const declared = [...WRITE_KINDS].sort();
  assert.deepEqual(registered, declared, "the registry must cover WRITE_KINDS exactly once each");
  assert.equal(new Set(WRITE_KINDS).size, WRITE_KINDS.length, "WRITE_KINDS must not contain duplicates");
  for (const kind of WRITE_KINDS) {
    const binding = WRITE_KIND_REGISTRY[kind];
    assert.ok(binding, `${kind} must have a registry entry`);
    assert.ok(["reddit", "x"].includes(binding.platform), `${kind} must bind to a known platform`);
    assert.equal(typeof binding.media, "boolean", `${kind} must declare whether it uses Core media`);
  }
});

test("write-kind registry: each platform's kinds map correctly", () => {
  for (const kind of WRITE_KINDS) {
    const expected = kind.startsWith("x_") ? "x" : "reddit";
    assert.equal(platformForWriteKind(kind), expected, `${kind} must route to ${expected}`);
  }
  const redditKinds = WRITE_KINDS.filter((kind) => platformForWriteKind(kind) === "reddit");
  const xKinds = WRITE_KINDS.filter((kind) => platformForWriteKind(kind) === "x");
  assert.deepEqual([...redditKinds].sort(), [
    "comment", "delete", "edit", "link_post", "media_post", "message_reply", "message_send",
    "reply", "save", "subscribe", "text_post", "unsubscribe", "unsave", "vote",
  ].sort());
  assert.deepEqual([...xKinds].sort(), [
    "x_bookmark_set", "x_direct_message", "x_follow_set", "x_like_set", "x_media_post",
    "x_post_create", "x_post_delete", "x_reply_create", "x_repost_set",
  ].sort());
});

test("write-kind registry: media kinds are explicitly declared, not string-matched", () => {
  const mediaKinds = WRITE_KINDS.filter((kind) => isMediaWriteKind(kind));
  assert.deepEqual([...mediaKinds].sort(), ["media_post", "x_media_post"]);
  // A kind that merely looks like media must not become media by accident.
  assert.equal(isMediaWriteKind("media"), false);
  assert.equal(isMediaWriteKind("media_post_extra"), false);
  assert.equal(isMediaWriteKind("x_media_post_extra"), false);
});

test("write-kind registry: an unknown kind fails closed instead of defaulting to Reddit", () => {
  for (const unknown of ["", "unknown_kind", "unknown", "x_", "x", "toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.equal(platformForWriteKind(unknown), undefined, `${unknown} must have no platform`);
    assert.equal(isMediaWriteKind(unknown), false, `${unknown} must not be a media kind`);
  }
  // Prototype members must not leak through a bare `in` or truthiness check.
  assert.equal(Object.hasOwn(WRITE_KIND_REGISTRY, "constructor"), false);
});

test("write-kind registry: read kinds map to their owning platform and fail closed", () => {
  for (const [kind, platform] of Object.entries(READ_KIND_PLATFORM)) {
    assert.equal(platformForReadKind(kind), platform, `${kind} must route to ${platform}`);
  }
  for (const unknown of ["", "unknown_kind", "x_", "unknown", "toString", "__proto__"]) {
    assert.equal(platformForReadKind(unknown), undefined, `${unknown} must have no read platform`);
  }
});

test("service boundary: an unregistered write kind is rejected, never routed to Reddit", async () => {
  const { service, store, adapter, accountId } = await fixture();
  try {
    for (const kind of ["unknown_kind", "x_unknown_kind", "media"]) {
      await assert.rejects(
        () => service.enqueueAction(principal, accountId, `unknown-${kind}`, { kind }, "actions.create"),
        (error: unknown) => {
          assert.ok(error instanceof ServiceError, `${kind} must fail with a ServiceError`);
          assert.equal(error.code, "VALIDATION_FAILED", `${kind} must be rejected as invalid, not dispatched`);
          return true;
        },
        `${kind} must be rejected at the service boundary`,
      );
    }
    assert.equal(adapter.submitCount, 0, "no unregistered kind may reach the adapter");
    assert.equal(store.listActions({ limit: 10 }).items.length, 0, "no action may be queued for an unregistered kind");
  } finally { store.close(); }
});

test("service boundary: a registered kind still routes only to its owning platform", async () => {
  const { service, store, accountId } = await fixture();
  try {
    // A well-formed X kind is still refused for a Reddit account; the registry
    // supplies the platform rather than an `x_` prefix heuristic.
    await assert.rejects(
      () => service.enqueueAction(principal, accountId, "cross-kind", { kind: "x_post_create", text: "no" }, "actions.create"),
      (error: unknown) => error instanceof ServiceError && error.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(store.listActions({ limit: 10 }).items.length, 0);
  } finally { store.close(); }

  const xStore = new LedgerStore(":memory:");
  const xAdapter = new XFixturePlatformAdapter();
  xAdapter.stageSession({ vaultHandle: "fixture:x:registry", nativeIdentity: "100" });
  const xService = new SocialGitService({ store: xStore, adapters: [xAdapter] });
  try {
    const account = await xService.createAccount(principal, { platform: "x", expectedNativeUserId: "100" });
    await xService.importConnection(principal, account.account.id, { vaultHandle: "fixture:x:registry", generation: 1 });
    // x_post_create belongs to X, so it must be accepted for an X account.
    const queued = await xService.enqueueAction(principal, account.account.id, "x-kind", { kind: "x_post_create", text: "yes" }, "x.actions.create");
    assert.equal(queued.action.kind, "x_post_create");
    // A Reddit-owned kind must be refused for that same X account.
    await assert.rejects(
      () => xService.enqueueAction(principal, account.account.id, "reddit-kind", { kind: "save", targetId: "t3_x" }, "x.actions.create"),
      (error: unknown) => error instanceof ServiceError && error.code === "CAPABILITY_UNAVAILABLE",
      "a kind owned by another platform must be refused",
    );
  } finally { xStore.close(); }
});
