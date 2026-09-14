import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RedditSessionTransport,
  RedditTransportError,
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
        "text_post:write", "link_post:write", "comment:write", "reply:write", "vote:write",
        "save:write", "unsave:write", "delete_own:write",
      ],
    );

    const feed = await fixture.service.read(principal, fixture.accountId, "feeds.list", {
      kind: "feed", subreddit: "test", limit: 5,
    });
    assert.equal((feed as any).items[0].nativeId, "t3_abc");
    assert.equal((feed as any).items[0].body, "Body");

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

  } finally {
    fixture.close();
  }
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
    const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-media-restart-"));
    const path = join(root, "actions.sqlite");
    const first = await mediaServiceFixture({ path });
    try {
      const media = await first.service.createMedia(principal, first.accountId, pngMedia());
      const queued = await first.service.enqueueAction(principal, first.accountId, `media-restart-${afterSubmit}`, {
        kind: "media_post", subreddit: "test", title: "Media", mediaRef: media.media.mediaRef,
      });
      const action = first.store.claimNextAction()!;
      first.store.transitionMediaFlow(action.id, "reserved", "leased", "ticket-restart");
      first.store.transitionMediaFlow(action.id, "leased", "uploaded", "ticket-restart");
      if (afterSubmit) first.store.beginMediaSubmission(action.id, "ticket-restart");
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
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-production-adapter-"));
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
            headers: { "content-type": "application/json" },
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

async function mediaServiceFixture(options: { failureCode?: string; path?: string } = {}) {
  const root = options.path ? null : mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-media-adapter-"));
  const phases: string[] = [];
  const provider: RedditTransportProvider = {
    async execute(input) {
      if (input.operation === "profile.get") {
        return { native: { nativeId: "t2_aliceid", canonicalUrl: "https://www.reddit.com/user/alice/" }, data: { username: "alice" } };
      }
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
  const service = new SocialGitService({ store, adapters: [new ProductionRedditAdapter(provider)] });
  const { account } = await service.createAccount({ callerId: principal.callerId, scopes: allScopes }, {
    platform: "reddit",
    expectedNativeUserId: "t2_aliceid",
  });
  await service.importConnection(principal, account.id, { vaultHandle: "vault://reddit/alice", generation: 1 });
  return {
    accountId: account.id,
    phases,
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
  if (call.path.startsWith("/r/test/hot.json")) {
    return { data: { children: [{ kind: "t3", data: postData() }], after: null, before: null } };
  }
  if (call.path === "/api/submit") {
    return { json: { errors: [], data: { name: "t3_created", url: "/r/test/comments/created/title/" } } };
  }
  if (call.path === "/api/comment") {
    return { json: { errors: [], data: { things: [{ data: { name: "t1_created", permalink: "/r/test/comments/abc/title/created/" } }] } } };
  }
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
