import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RedditSessionTransport,
  RedditTransportError,
  createRedditMessagingCandidateTestAdmission,
  createRedditSessionConnector,
} from "@social-git/reddit-adapter";
import { createRedditRouteAuthority } from "@social-git/worker-security";
import {
  LedgerStore,
  ProductionRedditAdapter,
  SocialGitService,
  type AccountRecord,
  type RedditTransportProvider,
} from "../src/index.ts";
import { allScopes, principal } from "./helpers.ts";

test("production PlatformAdapter executes admitted reads and writes through Core egress", async () => {
  const fixture = await serviceFixture();
  try {
    assert.deepEqual(
      (await fixture.service.listCapabilities(principal, fixture.accountId)).capabilities,
      [
        "profile:read", "subreddit:read", "feed:read", "post:read", "comments:read", "search:read",
        "user_profile:read", "user_content:read", "saved:read", "upvoted:read", "identity_health:read",
        "text_post:write", "link_post:write", "comment:write", "reply:write", "vote:write",
        "edit_own:write", "save:write", "unsave:write", "subscribe:write", "unsubscribe:write", "delete_own:write",
      ],
    );

    const feed = await fixture.service.read(principal, fixture.accountId, "feeds.list", {
      kind: "feed", subreddit: "test", limit: 5,
    });
    assert.equal((feed as any).items[0].nativeId, "t3_abc");
    assert.equal((feed as any).items[0].body, "Body");

    const search = await fixture.service.read(principal, fixture.accountId, "reads.search", {
      kind: "search", query: "fixture", subreddit: "test", sort: "top", timeframe: "week", cursor: "t3_previous1", limit: 5,
    });
    assert.equal((search as any).nextCursor, "t3_abc");
    assert.equal((search as any).rateLimit.remaining, 59);
    assert.match(String(fixture.calls.at(-1)?.path), /after=t3_previous1/u);

    const comments = await fixture.service.read(principal, fixture.accountId, "reads.comments", {
      kind: "comments", postId: "abc", sort: "new", cursor: "t1_previous1", limit: 5,
    });
    assert.equal((comments as any).items[0].replies[0].nativeId, "t1_child");
    assert.equal((comments as any).items[0].more[0].unsupportedReason, "COMMENT_MORE_EXPANSION_UNSUPPORTED");

    const user = await fixture.service.read(principal, fixture.accountId, "reads.userProfile", { kind: "user_profile", username: "fixture_user" });
    assert.equal((user as any).username, "fixture_user");
    const saved = await fixture.service.read(principal, fixture.accountId, "reads.saved", { kind: "saved", limit: 5 });
    assert.equal((saved as any).items[0].itemType, "post");
    const discovery = await fixture.service.listCapabilities(principal, fixture.accountId);
    assert.equal(discovery.unsupportedCapabilities.message_inbox, "AUTHORIZED_LIVE_INBOX_PROOF_MISSING");
    assert.equal(discovery.unsupportedCapabilities.message_send, "NO_VERIFIABLE_NATIVE_RESULT");
    assert.equal(discovery.capabilities.includes("message_inbox:read"), false);

    const queued = await fixture.service.enqueueAction(principal, fixture.accountId, "create-text-1", {
      kind: "text_post", subreddit: "test", title: "Title", text: "Body",
    });
    assert.equal((await fixture.service.runNextAction())?.state, "succeeded");
    assert.deepEqual((await fixture.service.getAction(principal, queued.action.id)).action.result, {
      nativeId: "t3_created",
      canonicalUrl: "https://www.reddit.com/r/test/comments/created/title/",
    });

    const replay = await fixture.service.enqueueAction(principal, fixture.accountId, "create-text-1", {
      kind: "text_post", subreddit: "test", title: "Title", text: "Body",
    });
    assert.equal(replay.replayed, true);
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);

    for (const [key, action, expectedNativeId] of [
      ["edit-owned", { kind: "edit", targetId: "t1_parent", text: "Edited body" }, "t1_parent"],
      ["subscribe-test", { kind: "subscribe", subreddit: "test" }, "t5_2qh1i"],
      ["unsubscribe-test", { kind: "unsubscribe", subreddit: "test" }, "t5_2qh1i"],
    ] as const) {
      const next = await fixture.service.enqueueAction(principal, fixture.accountId, key, action);
      assert.equal((await fixture.service.runNextAction())?.state, "succeeded");
      const result = (await fixture.service.getAction(principal, next.action.id)).action.result as { nativeId?: string } | undefined;
      assert.equal(result?.nativeId, expectedNativeId);
    }
    assert.deepEqual(
      fixture.calls.filter((call) => call.method === "POST").map((call) => call.path),
      ["/api/submit", "/api/editusertext", "/api/subscribe", "/api/subscribe"],
    );

  } finally {
    fixture.close();
  }
});

test("production Reddit messaging candidate fails closed before direct-session dispatch", async () => {
  const fixture = await mediaServiceFixture();
  try {
    const baselineExecutions = fixture.executions.length;
    await assert.rejects(
      fixture.service.read(principal, fixture.accountId, "reddit.messages.list", {
        kind: "message_inbox", folder: "inbox", limit: 25,
      }),
      (error: any) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    await assert.rejects(
      fixture.service.read(principal, fixture.accountId, "reddit.messages.thread", {
        kind: "message_thread", messageId: "t4_fixture",
      }),
      (error: any) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(fixture.executions.length, baselineExecutions);

    await assert.rejects(
      fixture.service.enqueueAction(principal, fixture.accountId, "message-disabled", {
        kind: "message_send", recipient: "fixture_user", subject: "Fixture", text: "Body",
      }, "reddit.messages.actions.create"),
      (error: any) => error.code === "CAPABILITY_UNAVAILABLE",
    );
    assert.equal(await fixture.service.runNextAction(), null);
    assert.equal(fixture.executions.length, baselineExecutions);
  } finally {
    fixture.close();
  }
});

test("explicit process-local messaging admission enables typed reads and dispatches writes without changing production defaults", async () => {
  const admission = createRedditMessagingCandidateTestAdmission();
  const fixture = await mediaServiceFixture({ messagingAdmission: admission });
  try {
    const discovery = await fixture.service.listCapabilities(principal, fixture.accountId);
    assert.equal(discovery.capabilities.includes("message_inbox:read"), true);
    assert.equal(discovery.capabilities.includes("message_reply:write"), true);
    assert.equal(discovery.unsupportedCapabilities.message_inbox, undefined);
    const inbox = await fixture.service.read(principal, fixture.accountId, "reddit.messages.list", { kind: "message_inbox", folder: "inbox", limit: 5 });
    assert.equal((inbox as any).items[0].nativeId, "t4_parent1");
    assert.equal((inbox as any).items[0].authorNativeId, "bob");

    const reply = await fixture.service.enqueueAction(principal, fixture.accountId, "message-reply", { kind: "message_reply", parentMessageId: "t4_parent1", text: "Reply" }, "reddit.messages.actions.create");
    assert.equal((await fixture.service.runNextAction())?.state, "succeeded");
    assert.equal(((await fixture.service.getAction(principal, reply.action.id)).action.result as { nativeId?: string } | undefined)?.nativeId, "t4_reply2");

    const send = await fixture.service.enqueueAction(principal, fixture.accountId, "message-send", { kind: "message_send", recipient: "bob", subject: "Hello", text: "Body" }, "reddit.messages.actions.create");
    assert.equal((await fixture.service.runNextAction())?.state, "UNKNOWN");
    assert.equal((await fixture.service.getAction(principal, send.action.id)).action.submissionMayHaveStarted, true);
    assert.deepEqual(fixture.executions.filter((operation) => operation.startsWith("message.")), ["message.inbox", "message.reply", "message.send"]);
  } finally { fixture.close(); }
});

test("production PlatformAdapter persists the Core media phase machine and returns native evidence", async () => {
  const fixture = await mediaServiceFixture();
  try {
    assert.equal((await fixture.service.listCapabilities(principal, fixture.accountId)).capabilities.includes("media_post:write"), true);
    const media = await fixture.service.createMedia(principal, fixture.accountId, pngMedia());
    const queued = await fixture.service.enqueueAction(principal, fixture.accountId, "media-success", {
      kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
    });
    const completed = await fixture.service.runNextAction();
    assert.equal(completed?.state, "succeeded");
    assert.deepEqual(completed?.result, {
      nativeId: "t3_media",
      canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/",
    });
    assert.deepEqual(fixture.phases, ["lease", "upload", "submit", "process"]);
    const flow = fixture.store.db.prepare("SELECT phase, worker_ticket FROM media_action_flows WHERE action_id=?").get(queued.action.id) as any;
    assert.equal(flow.phase, "processed");
    assert.equal(flow.worker_ticket, "ticket-1");
    assert.equal(fixture.store.getActionInternal(queued.action.id).submissionMayHaveStarted, true);

    const replay = await fixture.service.enqueueAction(principal, fixture.accountId, "media-success", {
      kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(fixture.phases, ["lease", "upload", "submit", "process"]);
  } finally {
    fixture.close();
  }
});

test("production media preflight preserves rate, challenge, revocation, and drift states before submission", async () => {
  for (const [failureCode, expectedState] of [
    ["RATE_LIMITED", "failed"],
    ["CHALLENGE_REQUIRED", "action_required"],
    ["SESSION_REVOKED", "action_required"],
    ["PROTOCOL_DRIFT", "failed"],
  ] as const) {
    const fixture = await mediaServiceFixture({ failureCode });
    try {
      const media = await fixture.service.createMedia(principal, fixture.accountId, pngMedia());
      const queued = await fixture.service.enqueueAction(principal, fixture.accountId, `media-${failureCode}`, {
        kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
      });
      assert.equal((await fixture.service.runNextAction())?.state, expectedState, failureCode);
      assert.equal(fixture.store.getActionInternal(queued.action.id).submissionMayHaveStarted, false, failureCode);
      assert.equal((fixture.store.db.prepare("SELECT phase FROM media_action_flows WHERE action_id=?").get(queued.action.id) as any).phase, "reserved");
      assert.deepEqual(fixture.phases, ["lease"]);
    } finally {
      fixture.close();
    }
  }
});

test("media process failure after submit is UNKNOWN and is never retried", async () => {
  const fixture = await mediaServiceFixture({ failureCode: "PROCESS_DISCONNECT" });
  try {
    const media = await fixture.service.createMedia(principal, fixture.accountId, pngMedia());
    const queued = await fixture.service.enqueueAction(principal, fixture.accountId, "media-unknown", {
      kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
    });
    assert.equal((await fixture.service.runNextAction())?.state, "UNKNOWN");
    assert.deepEqual(fixture.phases, ["lease", "upload", "submit", "process"]);
    assert.equal(await fixture.service.runNextAction(), null);
    assert.deepEqual(fixture.phases, ["lease", "upload", "submit", "process"]);
    const action = (await fixture.service.getAction(principal, queued.action.id)).action;
    assert.equal(action.submissionMayHaveStarted, true);
  } finally {
    fixture.close();
  }
});

test("restart recovery requeues pre-submit media but fences post-submit media as UNKNOWN", async () => {
  for (const afterSubmit of [false, true]) {
    const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-media-restart-"));
    const path = join(root, "actions.sqlite");
    const first = await mediaServiceFixture({ path });
    try {
      const media = await first.service.createMedia(principal, first.accountId, pngMedia());
      const queued = await first.service.enqueueAction(principal, first.accountId, `media-restart-${afterSubmit}`, {
        kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
      });
      const action = first.store.claimNextAction()!;
      assert.throws(
        () => (first.store.transitionMediaFlow as any)(action.id, "reserved", "leased", "ticket-restart"),
        (error: any) => error.code === "ACTION_STATE_CONFLICT",
      );
      first.store.transitionMediaFlow(action.id, "reserved", "leased", "ticket-restart", action.claimToken!);
      first.store.transitionMediaFlow(action.id, "leased", "uploaded", "ticket-restart", action.claimToken!);
      if (afterSubmit) {
        assert.throws(
          () => (first.store.beginMediaSubmission as any)(action.id, "ticket-restart"),
          (error: any) => error.code === "ACTION_STATE_CONFLICT",
        );
        first.store.beginMediaSubmission(action.id, "ticket-restart", action.claimToken!);
      }
      first.store.close();

      const store = new LedgerStore(path);
      const service = new SocialGitService({ store, adapters: [new ProductionRedditAdapter(first.provider)] });
      const recovered = store.getActionInternal(queued.action.id);
      assert.equal(recovered.state, afterSubmit ? "UNKNOWN" : "queued");
      const flow = store.db.prepare("SELECT phase, worker_ticket FROM media_action_flows WHERE action_id=?").get(queued.action.id) as any;
      assert.equal(flow.phase, afterSubmit ? "submitting" : "reserved");
      assert.equal(flow.worker_ticket, afterSubmit ? "ticket-restart" : null);
      assert.deepEqual(service.startupRecovery, afterSubmit ? { requeued: 0, unknown: 1 } : { requeued: 1, unknown: 0 });
      if (afterSubmit) assert.equal(await service.runNextAction(), null);
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("production PlatformAdapter keeps crash-after-submit UNKNOWN and reconciliation read-only", async () => {
  const fixture = await serviceFixture({ crashWrites: true });
  try {
    const queued = await fixture.service.enqueueAction(principal, fixture.accountId, "unknown-1", {
      kind: "comment", postId: "abc", text: "Maybe submitted",
    });
    assert.equal((await fixture.service.runNextAction())?.state, "UNKNOWN");
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);

    const reconciled = await fixture.service.reconcileAction(principal, queued.action.id);
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.action.state, "UNKNOWN");
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    fixture.close();
  }
});

async function serviceFixture({ crashWrites = false } = {}) {
  const root = mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-production-adapter-"));
  const calls: Array<Record<string, any>> = [];
  const transports = new Map<string, RedditSessionTransport>();
  const provider: RedditTransportProvider = {
    bind({ account }: { account: AccountRecord }) {
      const cached = transports.get(account.id);
      if (cached) return cached;
      const connectorId = `connector:${account.id}`;
      const sessionConnector = createRedditSessionConnector({
        cookies: { reddit_session: "not-a-live-session" },
        csrfToken: "fixture-modhash",
        wireConnector: async (request: any) => {
          const call = {
            ...request,
            path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
            body: request.body ? Buffer.from(request.body).toString("utf8") : "",
          };
          calls.push(call);
          if (crashWrites && request.method === "POST") throw new Error("fixture disconnect");
          return {
            status: 200,
            headers: { "content-type": "application/json", "x-ratelimit-remaining": "59", "x-ratelimit-used": "1", "x-ratelimit-reset": "60" },
            body: Buffer.from(JSON.stringify(responseFor(call)), "utf8"),
            remoteAddress: request.selectedAddress,
          };
        },
      });
      const binding = { tenantId: "tenant-test", accountId: account.id, routeId: `route:${account.id}`, generation: 1 };
      const authority = createRedditRouteAuthority({
        routes: [{
          id: binding.routeId,
          tenantId: binding.tenantId,
          accountId: binding.accountId,
          generation: binding.generation,
          connectorId,
        }],
        connectors: { [connectorId]: sessionConnector },
        resolver: async () => ["151.101.1.140"],
      });
      const transport = new RedditSessionTransport({
        routeAuthority: authority,
        binding,
        expectedNativeIdentity: account.expectedNativeUserId,
      });
      transports.set(account.id, transport);
      return transport;
    },
    revoke({ account }) { transports.get(account.id)?.revoke(); },
  };
  const store = new LedgerStore(join(root, "actions.sqlite"));
  const service = new SocialGitService({ store, adapters: [new ProductionRedditAdapter(provider)] });
  const { account } = await service.createAccount({ callerId: principal.callerId, scopes: allScopes }, {
    platform: "reddit",
    expectedNativeUserId: "t2_aliceid",
  });
  await service.importConnection(principal, account.id, { vaultHandle: "vault://reddit/alice", generation: 1 });
  return {
    accountId: account.id,
    calls,
    service,
    close() {
      for (const transport of transports.values()) transport.revoke();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function mediaServiceFixture(options: { failureCode?: string; path?: string; messagingAdmission?: ReturnType<typeof createRedditMessagingCandidateTestAdmission> } = {}) {
  const root = options.path ? null : mkdtempSync(join(process.env.SOCIAL_GIT_SCRATCH_DIR ?? tmpdir(), "social-git-media-adapter-"));
  const phases: string[] = [];
  const executions: string[] = [];
  const provider: RedditTransportProvider = {
    async execute(input) {
      executions.push(input.operation);
      if (input.operation === "profile.get") {
        return { native: { nativeId: "t2_aliceid", canonicalUrl: "https://www.reddit.com/user/alice/" }, data: { username: "alice" } };
      }
      if (input.operation === "message.inbox") return { native: null, data: { items: [{ nativeId: "t4_parent1", canonicalUrl: "https://www.reddit.com/message/messages/parent1/", author: "bob", recipient: "alice", subject: "Hello", body: "Body", wasRead: false, parentNativeId: null, created_utc: 1_800_000_000 }], page: { after: null, before: null } } };
      if (input.operation === "message.thread") return { native: { nativeId: "t4_parent1", canonicalUrl: "https://www.reddit.com/message/messages/parent1/" }, data: { nativeId: "t4_parent1", canonicalUrl: "https://www.reddit.com/message/messages/parent1/", author: "bob", recipient: "alice", subject: "Hello", body: "Body", wasRead: false, parentNativeId: null, created_utc: 1_800_000_000 } };
      if (input.operation === "message.reply") return { native: { nativeId: "t4_reply2", canonicalUrl: "https://www.reddit.com/message/messages/reply2/" }, data: { created: true, kind: "private_message_reply" } };
      if (input.operation === "message.send") throw new RedditTransportError("PROTOCOL_DRIFT", "compose has no native proof", { submissionMayHaveStarted: true });
      const phase = input.operation.replace("reddit.post.media.", "");
      phases.push(phase);
      if (phase === "lease" && options.failureCode) {
        const code = options.failureCode;
        if (code !== "PROCESS_DISCONNECT") {
          throw new RedditTransportError(code, "synthetic preflight stop", {
            retryable: code === "RATE_LIMITED",
            actionRequired: ["CHALLENGE_REQUIRED", "SESSION_REVOKED", "PROTOCOL_DRIFT"].includes(code),
          });
        }
      }
      if (phase === "upload") {
        const body = input.payload;
        assert.equal(typeof body.dataBase64, "string");
        assert.equal(Buffer.from(body.dataBase64 as string, "base64").length, 12);
      }
      if (phase === "process" && options.failureCode === "PROCESS_DISCONNECT") {
        throw new RedditTransportError("WORKER_UNAVAILABLE", "synthetic process disconnect", {
          submissionMayHaveStarted: true,
        });
      }
      if (phase === "process") {
        return { native: { nativeId: "t3_media", canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/" }, data: { created: true } };
      }
      return { native: null, data: { ticket: "ticket-1" } };
    },
  };
  const store = new LedgerStore(options.path ?? join(root!, "actions.sqlite"));
  const service = new SocialGitService({ store, adapters: [new ProductionRedditAdapter(provider, { messagingAdmission: options.messagingAdmission })] });
  const { account } = await service.createAccount({ callerId: principal.callerId, scopes: allScopes }, {
    platform: "reddit",
    expectedNativeUserId: "t2_aliceid",
  });
  await service.importConnection(principal, account.id, { vaultHandle: "vault://reddit/alice", generation: 1 });
  return {
    accountId: account.id,
    phases,
    executions,
    provider,
    service,
    store,
    close() {
      try { store.close(); } catch { /* already closed by a restart test */ }
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}

function responseFor(call: Record<string, any>) {
  if (call.path === "/api/me.json") return { data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } };
  if (call.path.startsWith("/r/test/about.json")) return { data: { id: "2qh1i", display_name: "test", subscribers: 100 } };
  if (call.path.startsWith("/r/test/hot.json")) {
    return { data: { children: [{ kind: "t3", data: postData() }], after: null, before: null } };
  }
  if (call.path.startsWith("/search.json") || call.path.startsWith("/r/test/search.json") || call.path.startsWith("/user/alice/saved.json") || call.path.startsWith("/user/alice/upvoted.json") || call.path.startsWith("/user/fixture_user/submitted.json")) {
    return { data: { children: [{ kind: "t3", data: postData() }], after: "t3_abc", before: null } };
  }
  if (call.path.startsWith("/user/fixture_user/about.json")) {
    return { data: { id: "fixtureuser", name: "fixture_user", link_karma: 3, comment_karma: 4 } };
  }
  if (call.path.startsWith("/comments/abc.json")) {
    return [
      { data: { children: [{ kind: "t3", data: postData() }], after: null, before: null } },
      { data: { children: [{ kind: "t1", data: {
        id: "parent", name: "t1_parent", permalink: "/r/test/comments/abc/title/parent/", author: "alice", body: "Parent", parent_id: "t3_abc",
        replies: { data: { children: [
          { kind: "t1", data: { id: "child", name: "t1_child", permalink: "/r/test/comments/abc/title/child/", author: "alice", body: "Child", parent_id: "t1_parent" } },
          { kind: "more", data: { parent_id: "t1_parent", count: 1, children: ["later"] } },
        ], after: null, before: null } },
      } }], after: null, before: null } },
    ];
  }
  if (call.path.startsWith("/api/info.json")) {
    return { data: { children: [{ kind: "t1", data: {
      id: "parent", name: "t1_parent", permalink: "/r/test/comments/abc/title/parent/", author: "alice", body: "Parent"
    } }], after: null, before: null } };
  }
  if (call.path === "/api/submit") {
    return { json: { errors: [], data: { name: "t3_created", url: "/r/test/comments/created/title/" } } };
  }
  if (call.path === "/api/comment") {
    return { json: { errors: [], data: { things: [{ data: { name: "t1_created", permalink: "/r/test/comments/abc/title/created/" } }] } } };
  }
  if (["/api/editusertext", "/api/subscribe"].includes(call.path)) return { json: { errors: [] } };
  throw new Error(`Unhandled fixture request: ${call.path}`);
}

function postData() {
  return {
    id: "abc", name: "t3_abc", permalink: "/r/test/comments/abc/title/",
    title: "Title", author: "alice", subreddit: "test", selftext: "Body", score: 1,
  };
}

function pngMedia() {
  return {
    filename: "fixture.png",
    mimeType: "image/png",
    dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64"),
  };
}
