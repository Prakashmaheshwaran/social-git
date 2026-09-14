import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RedditSessionTransport,
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

    const media = await fixture.service.enqueueAction(principal, fixture.accountId, "media-1", {
      kind: "media_post", subreddit: "test", title: "Media", mediaRef: "core://media/1",
    });
    assert.equal((await fixture.service.runNextAction())?.state, "failed");
    assert.equal(((await fixture.service.getAction(principal, media.action.id)).action.error as any)?.code, "CAPABILITY_DISABLED");
    assert.equal(fixture.calls.filter((call) => call.method === "POST").length, 1);
  } finally {
    fixture.close();
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
