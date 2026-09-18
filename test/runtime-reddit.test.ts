import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionRuntime, decodeWorkerMessage, encodeWorkerMessage } from "@social-git/core";
import { CORE_ERROR_CODES, RedditTransportError, createRedditMessagingCandidateTestAdmission } from "@social-git/reddit-adapter";
import { CoreRedditTransportProvider, DirectorySessionSource, ProductionRedditCommandDispatcher, RemoteRedditCommandDispatcher, type AccountRecord } from "../src/index.ts";
import { REDDIT_COMMAND_MAC_CONTEXT, RedditCommandMacSigner, RedditCommandMacVerifier } from "../src/reddit-ipc-auth.ts";
import { createRedditWorkerHttpServer } from "../src/reddit-worker-http.ts";

const REDDIT_COMMAND_KEY = Buffer.alloc(32, 0xb6);

test("Reddit command MAC rejects replayed and stale request envelopes", () => {
  const now = 1_800_000_000_000;
  const body = Buffer.from("bounded-command");
  const signer = new RedditCommandMacSigner(REDDIT_COMMAND_KEY, { now: () => now, nonce: () => Buffer.alloc(24, 1) });
  const verifier = new RedditCommandMacVerifier(REDDIT_COMMAND_KEY, { now: () => now });
  const headers = signer.headers(body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest);
  assert.equal(verifier.verify({ ...headers }, body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);
  assert.equal(verifier.verify({ ...headers }, body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
  const staleSigner = new RedditCommandMacSigner(REDDIT_COMMAND_KEY, { now: () => now - 30_001, nonce: () => Buffer.alloc(24, 2) });
  assert.equal(verifier.verify({ ...staleSigner.headers(body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest) }, body, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
  signer.close(); staleSigner.close(); verifier.close(); body.fill(0);
});

test("Reddit private worker authenticates readiness and dispatch and rejects a cross-platform key", async () => {
  let calls = 0;
  const server = createRedditWorkerHttpServer({
    commandKey: REDDIT_COMMAND_KEY,
    dispatcher: {
      execute: async (serialized: Uint8Array) => {
        calls += 1;
        return { message: workerResult("SUCCEEDED"), platformResult: { native: null, data: { items: [] } } };
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`;
  const command = dispatcherCommand();
  const remote = new RemoteRedditCommandDispatcher(url, REDDIT_COMMAND_KEY);
  const foreign = new RemoteRedditCommandDispatcher(url, Buffer.alloc(32, 0xb7));
  try {
    assert.equal(await remote.ready(), true);
    assert.equal(await foreign.ready(), false);
    const result = await remote.execute(command);
    assert.deepEqual(result.platformResult, { native: null, data: { items: [] } });
    await assert.rejects(foreign.execute(command), (error: unknown) => (error as { code?: string }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT);
    assert.equal(calls, 1);
  } finally {
    command.fill(0);
    remote.close();
    foreign.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Reddit remote rejects a harvested signed response that is replayed for another request nonce", async () => {
  let harvested: { body: Buffer; headers: Record<string, string> } | undefined;
  const responseSigner = new RedditCommandMacSigner(REDDIT_COMMAND_KEY);
  const server = createServer((request, response) => {
    request.resume();
    if (!harvested) {
      const body = Buffer.from(JSON.stringify({
        version: 1,
        requestNonce: request.headers["x-social-git-command-nonce"],
        messageBase64: Buffer.from(workerResult("SUCCEEDED")).toString("base64url"),
        platformResult: { native: null, data: { items: [] } },
      }));
      harvested = { body, headers: { ...responseSigner.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(200)) } };
    }
    const replay = harvested;
    response.writeHead(200, { "content-type": "application/json", "content-length": replay.body.length, ...replay.headers });
    response.end(replay.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let nonce = 0;
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY, {
    nonce: () => Buffer.alloc(24, ++nonce),
  });
  const command = dispatcherCommand();
  try {
    await remote.execute(command);
    await assert.rejects(remote.execute(command), (error: unknown) => (error as { code?: string }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT);
  } finally {
    command.fill(0);
    harvested?.body.fill(0);
    responseSigner.close();
    remote.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Reddit command dispatch never follows a redirect carrying bound command bytes", async () => {
  let redirectTargetCalls = 0;
  const target = createServer((request, response) => { redirectTargetCalls += 1; request.resume(); response.writeHead(204).end(); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/harvest`;
  let sourceCalls = 0;
  const source = createServer((request, response) => { sourceCalls += 1; request.resume(); response.writeHead(307, { location: targetUrl }).end(); });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(source.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const write = mediaWorkerCommand("message.reply", { parentMessageNativeId: "t4_parent1", body: "Reply" }, "redirect-write");
  const read = dispatcherCommand();
  try {
    await assert.rejects(remote.execute(write), (error: unknown) => (error as { code?: string; submissionMayHaveStarted?: boolean; retryable?: boolean }).code === CORE_ERROR_CODES.WORKER_UNAVAILABLE
      && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === true
      && (error as { retryable?: boolean }).retryable !== true);
    await assert.rejects(remote.execute(read), (error: unknown) => (error as { code?: string; submissionMayHaveStarted?: boolean; retryable?: boolean }).code === CORE_ERROR_CODES.WORKER_UNAVAILABLE
      && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === false
      && (error as { retryable?: boolean }).retryable === true);
    assert.equal(sourceCalls, 2);
    assert.equal(redirectTargetCalls, 0);
  } finally {
    write.fill(0); read.fill(0); remote.close();
    await Promise.all([
      new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve())),
    ]);
  }
});

test("remote Reddit dispatcher accepts only bound worker result envelopes", async () => {
  const successMessage = workerResult("SUCCEEDED");
  const failureMessage = workerResult("AUTH_FAILURE");
  const replies = [
    {
      version: 1,
      messageBase64: Buffer.from(successMessage).toString("base64url"),
      platformResult: { native: null, data: { items: [] } },
    },
    {
      version: 1,
      messageBase64: Buffer.from(failureMessage).toString("base64url"),
      failure: {
        name: "RedditTransportError",
        code: CORE_ERROR_CODES.AUTHENTICATION_FAILED,
        message: "The Reddit session is not authenticated",
        retryable: false,
        actionRequired: true,
        submissionMayHaveStarted: false,
      },
    },
    {
      version: 1,
      messageBase64: Buffer.from(successMessage).toString("base64url"),
      platformResult: { native: null, data: { items: [] } },
      failure: {
        name: "RedditTransportError",
        code: CORE_ERROR_CODES.AUTHENTICATION_FAILED,
        message: "conflicting synthetic result",
        retryable: false,
        actionRequired: true,
        submissionMayHaveStarted: false,
      },
    },
  ];
  const server = createServer((request, response) => {
    request.resume();
    const requestNonce = request.headers["x-social-git-command-nonce"];
    const body = Buffer.from(JSON.stringify({ ...replies.shift(), requestNonce }));
    const signer = new RedditCommandMacSigner(REDDIT_COMMAND_KEY);
    response.writeHead(200, { "content-type": "application/json", "content-length": body.length, ...signer.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(200)) });
    response.end(body);
    signer.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const command = dispatcherCommand();
  try {
    const dispatcher = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${port}/v1/dispatch`, REDDIT_COMMAND_KEY);
    const success = await dispatcher.execute(command);
    assert.deepEqual(success.platformResult, { native: null, data: { items: [] } });
    const failure = await dispatcher.execute(command);
    assert.equal((failure.error as { code?: string }).code, CORE_ERROR_CODES.AUTHENTICATION_FAILED);
    assert.equal((failure.error as { actionRequired?: boolean }).actionRequired, true);
    await assert.rejects(
      dispatcher.execute(command),
      (error: unknown) => (error as { code?: string }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT,
    );
  } finally {
    command.fill(0);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("authenticated Core to HTTP worker lifecycle dispatches an explicitly admitted bound Reddit reply", async () => {
  const calls: string[] = [];
  const dispatcher = new ProductionRedditCommandDispatcher({
    messagingAdmission: createRedditMessagingCandidateTestAdmission(),
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = `${new URL(request.url).pathname}${new URL(request.url).search}`;
      calls.push(path);
      const body = path === "/api/me.json"
        ? { data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } }
        : path.startsWith("/message/messages/parent1.json")
          ? { data: { children: [{ kind: "t4", data: redditMessage({ id: "parent1", author: "bob", dest: "alice" }) }], after: null, before: null } }
          : path.startsWith("/api/comment")
            ? { json: { errors: [], data: { things: [{ kind: "t4", data: redditMessage({ id: "reply2", author: "alice", dest: "bob", parent_id: "t4_parent1", body: "Reply" }) }] } } }
            : (() => { throw new Error(`unhandled Reddit fixture: ${path}`); })();
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)), remoteAddress: request.selectedAddress };
    },
  });
  const server = createRedditWorkerHttpServer({ dispatcher, commandKey: REDDIT_COMMAND_KEY });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const command = mediaWorkerCommand("message.reply", { parentMessageNativeId: "t4_parent1", body: "Reply" }, "message-reply");
  try {
    const result = await remote.execute(command);
    assert.equal(result.platformResult?.native?.nativeId, "t4_reply2");
    assert.deepEqual(calls, ["/api/me.json", "/message/messages/parent1.json?raw_json=1", "/api/comment?raw_json=1"]);
  } finally {
    command.fill(0);
    remote.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("authenticated worker loss after a write command is terminal ambiguous and is never auto-retried", async () => {
  let calls = 0;
  const server = createRedditWorkerHttpServer({
    commandKey: REDDIT_COMMAND_KEY,
    dispatcher: { execute: async () => { calls += 1; throw new Error("synthetic worker loss after possible submit"); } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const command = mediaWorkerCommand("message.reply", { parentMessageNativeId: "t4_parent1", body: "Reply" }, "ambiguous-reply");
  try {
    await assert.rejects(remote.execute(command), (error: unknown) => (error as { submissionMayHaveStarted?: boolean; retryable?: boolean }).submissionMayHaveStarted === true
      && (error as { retryable?: boolean }).retryable !== true);
    assert.equal(calls, 1);
  } finally {
    command.fill(0);
    remote.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Core clears the active lease and records UNKNOWN when HTTP dispatch is lost after a write leaves Core", async () => {
  let calls = 0;
  const server = createRedditWorkerHttpServer({
    commandKey: REDDIT_COMMAND_KEY,
    dispatcher: { execute: async (serialized) => {
      calls += 1;
      if (calls !== 1) throw new Error("synthetic post-dispatch loss");
      const command = decodeWorkerMessage(serialized);
      if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
      return {
        message: encodeWorkerMessage({ version: 1, type: "social-git.worker.result", requestId: command.requestId, tenantId: command.tenantId, accountId: command.accountId, platform: "reddit", generation: command.generation, leaseId: command.leaseId, fence: command.fence, status: "SUCCEEDED", observedNativeIdentity: "reddit:t2_alpha", nativeId: "t2_aliceid", canonicalUrl: "https://www.reddit.com/user/alice/" }),
        platformResult: { native: { nativeId: "t2_aliceid", canonicalUrl: "https://www.reddit.com/user/alice/" }, data: { username: "alice" } },
      };
    } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-reddit-command-loss-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  const provider = new CoreRedditTransportProvider({ runtime, dispatcher: remote, source: { consume() { throw new Error("unused one-time source"); } } });
  try {
    provider.importDirectConnection({
      account: account(), generation: 1,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic" }, csrfToken: "synthetic" })),
      networkRoute: { id: "direct-route-alpha", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    await provider.execute({ account: account(), vaultHandle: "unused", intent: "identity_validation", operation: "profile.get", payload: {} });
    await assert.rejects(provider.execute({
      account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
      payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
    }), (error: unknown) => (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === true);
    const state = runtime.getAccountState("account-alpha");
    assert.equal(state.health, "unknown");
    assert.equal(state.activeLease, null);
    assert.equal(calls, 2);
  } finally {
    runtime.close();
    remote.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Core terminalizes mismatched authenticated Reddit worker results without retry", async () => {
  for (const mismatch of ["requestId", "leaseId", "fence", "accountId"] as const) {
    const fixture = await providerHttpFixture((serialized, call) => {
      const command = decodeWorkerMessage(serialized);
      if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
      return boundWorkerSuccess(command, call === 1 ? {} : mismatchedBinding(command, mismatch));
    });
    try {
      await fixture.connect();
      await assert.rejects(
        fixture.provider.execute({
          account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
          payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
        }),
        (error: unknown) => (error as { code?: string; retryable?: boolean; submissionMayHaveStarted?: boolean }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT
          && (error as { retryable?: boolean }).retryable !== true
          && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === true,
      );
      const state = fixture.runtime.getAccountState("account-alpha");
      assert.equal(state.health, "unknown", mismatch);
      assert.equal(state.activeLease, null, mismatch);
      await assert.rejects(fixture.provider.execute({
        account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
        payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
      }));
      assert.equal(fixture.calls(), 2, mismatch);
    } finally { await fixture.close(); }
  }

  const readFixture = await providerHttpFixture((serialized, call) => {
    const command = decodeWorkerMessage(serialized);
    if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
    return boundWorkerSuccess(command, call === 1 ? {} : { requestId: `${command.requestId}-wrong` });
  });
  try {
    await readFixture.connect();
    await assert.rejects(
      readFixture.provider.execute({ account: account(), vaultHandle: "unused", intent: "read", operation: "profile.get", payload: {} }),
      (error: unknown) => (error as { code?: string; submissionMayHaveStarted?: boolean }).code === CORE_ERROR_CODES.PROTOCOL_DRIFT
        && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === false,
    );
    const state = readFixture.runtime.getAccountState("account-alpha");
    assert.equal(state.health, "protocol_drift");
    assert.equal(state.activeLease, null);
    assert.equal(readFixture.calls(), 2);
  } finally { await readFixture.close(); }
});

test("fresh authenticated worker stopping is pre-submit while a mismatched stopping proof remains UNKNOWN", async () => {
  const stopping = await providerHttpFixture((serialized) => {
    const command = decodeWorkerMessage(serialized);
    if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
    return boundWorkerSuccess(command);
  });
  try {
    await stopping.connect();
    stopping.worker.beginShutdown();
    await assert.rejects(
      stopping.provider.execute({
        account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
        payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
      }),
      (error: unknown) => (error as { code?: string; submissionMayHaveStarted?: boolean }).code === CORE_ERROR_CODES.WORKER_UNAVAILABLE
        && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === false,
    );
    const state = stopping.runtime.getAccountState("account-alpha");
    assert.equal(state.health, "healthy");
    assert.equal(state.activeLease, null);
    assert.equal(stopping.calls(), 1);
    const replacementWorker = createRedditWorkerHttpServer({
      commandKey: REDDIT_COMMAND_KEY,
      dispatcher: { execute: async (serialized) => {
        const command = decodeWorkerMessage(serialized);
        if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
        return boundWorkerSuccess(command);
      } },
    });
    await new Promise<void>((resolve) => replacementWorker.listen(0, "127.0.0.1", resolve));
    const replacementRemote = new RemoteRedditCommandDispatcher(
      `http://127.0.0.1:${(replacementWorker.address() as AddressInfo).port}/v1/dispatch`,
      REDDIT_COMMAND_KEY,
    );
    const replacementProvider = new CoreRedditTransportProvider({
      runtime: stopping.runtime,
      dispatcher: replacementRemote,
      source: { consume() { throw new Error("unused one-time source"); } },
    });
    try {
      await replacementProvider.execute({
        account: account(), vaultHandle: "unused", intent: "read", operation: "profile.get", payload: {},
      });
      assert.equal(stopping.runtime.getAccountState("account-alpha").health, "healthy");
    } finally {
      replacementRemote.close();
      await new Promise<void>((resolve, reject) => replacementWorker.close((error) => error ? reject(error) : resolve()));
    }
  } finally { await stopping.close(); }

  let requests = 0;
  const responseSigner = new RedditCommandMacSigner(REDDIT_COMMAND_KEY);
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests += 1;
    const serialized = Buffer.concat(chunks);
    try {
      const command = decodeWorkerMessage(serialized);
      if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
      const success = boundWorkerSuccess(command);
      const value = requests === 1
        ? {
          version: 1,
          requestNonce: request.headers["x-social-git-command-nonce"],
          messageBase64: Buffer.from(success.message).toString("base64url"),
          platformResult: success.platformResult,
        }
        : { version: 1, code: "WORKER_STOPPING", requestNonce: "harvested-nonce" };
      success.message.fill(0);
      const body = Buffer.from(JSON.stringify(value));
      const status = requests === 1 ? 200 : 503;
      response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...responseSigner.headers(body, REDDIT_COMMAND_MAC_CONTEXT.response(status)) });
      response.end(body);
    } finally { serialized.fill(0); for (const chunk of chunks) chunk.fill(0); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-reddit-stopping-replay-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  const provider = new CoreRedditTransportProvider({ runtime, dispatcher: remote, source: { consume() { throw new Error("unused one-time source"); } } });
  try {
    provider.importDirectConnection({
      account: account(), generation: 1,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic" }, csrfToken: "synthetic" })),
      networkRoute: { id: "direct-route-alpha", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    await provider.execute({ account: account(), vaultHandle: "unused", intent: "identity_validation", operation: "profile.get", payload: {} });
    await assert.rejects(provider.execute({
      account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
      payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
    }), (error: unknown) => (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === true);
    const state = runtime.getAccountState("account-alpha");
    assert.equal(state.health, "unknown");
    assert.equal(state.activeLease, null);
    assert.equal(requests, 2);
  } finally {
    runtime.close(); remote.close(); responseSigner.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired production Reddit commands stop before egress and clear the Core lease definitively", async () => {
  let coreNow = 1_800_000_000_000;
  let workerNow = coreNow;
  let connectorCalls = 0;
  const dispatcher = new ProductionRedditCommandDispatcher({
    now: () => workerNow,
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      connectorCalls += 1;
      assert.equal(new URL(request.url).pathname, "/api/me.json");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ data: { id: "alpha", name: "alpha", link_karma: 1, comment_karma: 2 } })),
        remoteAddress: request.selectedAddress,
      };
    },
  });
  const worker = createRedditWorkerHttpServer({ commandKey: REDDIT_COMMAND_KEY, dispatcher });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-reddit-expired-command-"));
  const runtime = new SessionRuntime({
    databasePath: join(root, "sessions.sqlite"),
    tenantId: "tenant-test",
    masterKey: randomBytes(32),
    auditKey: randomBytes(32),
    now: () => coreNow,
  });
  const provider = new CoreRedditTransportProvider({
    runtime,
    dispatcher: remote,
    source: { consume() { throw new Error("unused one-time source"); } },
  });
  try {
    provider.importDirectConnection({
      account: account(), generation: 1,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic" }, csrfToken: "synthetic" })),
      networkRoute: { id: "direct-route-alpha", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    await provider.execute({ account: account(), vaultHandle: "unused", intent: "identity_validation", operation: "profile.get", payload: {} });
    workerNow = coreNow + 29_999;
    await provider.execute({ account: account(), vaultHandle: "unused", intent: "read", operation: "profile.get", payload: {} });
    assert.equal(connectorCalls, 2, "a command remains valid until its exact expiry boundary");

    workerNow = coreNow + 30_000;
    await assert.rejects(
      provider.execute({
        account: account(), vaultHandle: "unused", intent: "write", operation: "message.reply",
        payload: { parentMessageNativeId: "t4_parent1", body: "Reply" },
      }),
      (error: unknown) => (error as { code?: string; retryable?: boolean; submissionMayHaveStarted?: boolean }).code === CORE_ERROR_CODES.WORKER_UNAVAILABLE
        && (error as { retryable?: boolean }).retryable !== true
        && (error as { submissionMayHaveStarted?: boolean }).submissionMayHaveStarted === false,
    );
    assert.equal(connectorCalls, 2, "an expired command must not reach a session connector");
    const state = runtime.getAccountState("account-alpha");
    assert.equal(state.health, "healthy");
    assert.equal(state.activeLease, null);
    coreNow = workerNow;
    await provider.execute({ account: account(), vaultHandle: "unused", intent: "read", operation: "profile.get", payload: {} });
    assert.equal(connectorCalls, 3, "a fresh command remains available after a proven pre-submit expiry");
  } finally {
    runtime.close();
    remote.close();
    await new Promise<void>((resolve, reject) => worker.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("authenticated Reddit worker failures never echo typed secret-like messages", async () => {
  const sentinel = "cookie: REDDIT_SESSION_SENTINEL";
  const worker = createRedditWorkerHttpServer({
    commandKey: REDDIT_COMMAND_KEY,
    dispatcher: { execute: async (serialized) => {
      const command = decodeWorkerMessage(serialized);
      if (command.type !== "social-git.worker.command") throw new Error("expected worker command");
      const result = boundWorkerSuccess(command, { status: "PROTOCOL_DRIFT" });
      return {
        message: result.message,
        error: new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, sentinel, { actionRequired: true }),
      };
    } },
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(
    `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1/dispatch`,
    REDDIT_COMMAND_KEY,
  );
  const command = dispatcherCommand();
  try {
    const result = await remote.execute(command);
    assert.ok(result.error);
    const failure = result.error as Error;
    assert.equal(failure.message, "The Reddit worker failed closed");
    assert.equal(failure.message.includes("REDDIT_SESSION_SENTINEL"), false);
    result.message.fill(0);
  } finally {
    command.fill(0);
    remote.close();
    await new Promise<void>((resolve, reject) => worker.close((error) => error ? reject(error) : resolve()));
  }
});

test("production Reddit worker keeps media lease secrets local across the phased protocol", async () => {
  const redditCalls: Array<{ path: string; body: string }> = [];
  const uploads: Array<{ size: number; fields: readonly { name: string; value: string }[] }> = [];
  const dispatcher = new ProductionRedditCommandDispatcher({
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = `${new URL(request.url).pathname}${new URL(request.url).search}`;
      const body = request.body ? Buffer.from(request.body).toString("utf8") : "";
      redditCalls.push({ path, body });
      const response = path === "/api/me.json"
        ? { data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } }
        : path === "/api/media/asset.json"
          ? {
            args: {
              action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com",
              fields: [
                { name: "key", value: "fixture/media.png" },
                { name: "policy", value: "signed-policy-must-stay-in-worker" },
                { name: "x-amz-signature", value: "signed-value-must-stay-in-worker" },
              ],
            },
          }
          : path === "/api/submit"
            ? { json: { errors: [], data: { websocket_url: "wss://wss.redditmedia.com/opaque-process" } } }
            : (() => { throw new Error(`unhandled Reddit fixture: ${path}`); })();
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(response)),
        remoteAddress: request.selectedAddress,
      };
    },
    uploadMedia: async (input) => {
      uploads.push({ size: input.data.length, fields: input.fields });
      assert.equal(input.uploadUrl, "https://reddit-uploaded-media.s3-accelerate.amazonaws.com/");
    },
    processMedia: async (input) => {
      assert.equal(input.websocketUrl, "wss://wss.redditmedia.com/opaque-process");
      return {
        native: { nativeId: "t3_media", canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/" },
        data: { created: true, kind: "media_post" },
      };
    },
  });
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const metadata = {
    filename: "fixture.png",
    mimeType: "image/png",
    sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
  const lease = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.lease", metadata, "lease"));
  assert.equal(lease.error, undefined);
  const ticket = String((lease.platformResult?.data as any).ticket);
  assert.match(ticket, /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.stringify(lease.platformResult).includes("signed-policy"), false);

  const upload = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.upload", {
    ticket,
    dataBase64: data.toString("base64"),
    sizeBytes: data.length,
    sha256: metadata.sha256,
  }, "upload"));
  assert.equal(upload.error, undefined);
  const submit = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.submit", {
    ticket, subreddit: "test", title: "Media",
  }, "submit"));
  assert.equal(submit.error, undefined);
  const process = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.process", { ticket }, "process"));
  assert.equal(process.error, undefined);
  assert.deepEqual(process.platformResult?.native, {
    nativeId: "t3_media",
    canonicalUrl: "https://www.reddit.com/r/test/comments/media/title/",
  });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.size, data.length);
  assert.equal(uploads[0]?.fields.some(({ value }) => value.includes("signed-policy")), true);
  assert.equal(redditCalls.filter(({ path }) => path === "/api/media/asset.json").length, 1);
  assert.equal(redditCalls.filter(({ path }) => path === "/api/submit").length, 1);
  assert.equal(new URLSearchParams(redditCalls.find(({ path }) => path === "/api/submit")?.body).get("kind"), "image");
});

test("production Reddit worker reports media processing loss as UNKNOWN without another submit", async () => {
  let submitCalls = 0;
  const dispatcher = new ProductionRedditCommandDispatcher({
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/submit") submitCalls += 1;
      const response = path === "/api/me.json"
        ? { data: { id: "aliceid", name: "alice" } }
        : path === "/api/media/asset.json"
          ? { args: { action: "//reddit-uploaded-media.s3-accelerate.amazonaws.com", fields: [{ name: "key", value: "fixture/media.png" }] } }
          : { json: { errors: [], data: { websocket_url: "wss://wss.redditmedia.com/opaque-process" } } };
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(response)), remoteAddress: request.selectedAddress };
    },
    uploadMedia: async () => undefined,
    processMedia: async () => { throw new Error("synthetic worker loss after submit"); },
  });
  const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const leased = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.lease", {
    filename: "fixture.png", mimeType: "image/png", sizeBytes: data.length, sha256,
  }, "unknown-lease"));
  const ticket = String((leased.platformResult?.data as any).ticket);
  await dispatcher.execute(mediaWorkerCommand("reddit.post.media.upload", {
    ticket, dataBase64: data.toString("base64"), sizeBytes: data.length, sha256,
  }, "unknown-upload"));
  await dispatcher.execute(mediaWorkerCommand("reddit.post.media.submit", { ticket, subreddit: "test", title: "Media" }, "unknown-submit"));
  const process = await dispatcher.execute(mediaWorkerCommand("reddit.post.media.process", { ticket }, "unknown-process"));
  assert.equal((process.error as any)?.submissionMayHaveStarted, true);
  assert.equal(submitCalls, 1);
});

test("production Reddit worker makes a redirected write terminal UNKNOWN without replay", async () => {
  const redditCalls: string[] = [];
  const dispatcher = new ProductionRedditCommandDispatcher({
    resolver: async () => ["151.101.1.140"],
    sessionConnectorFactory: () => async (request: any) => {
      const path = new URL(request.url).pathname;
      redditCalls.push(path);
      if (path === "/api/me.json") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ data: { id: "aliceid", name: "alice", link_karma: 1, comment_karma: 2 } })),
          remoteAddress: request.selectedAddress,
        };
      }
      if (path === "/r/test/about.json") {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ data: { id: "2qh1i", display_name: "test", subscribers: 100 } })),
          remoteAddress: request.selectedAddress,
        };
      }
      return {
        status: 307,
        headers: { location: "/api/submit-again" },
        body: Buffer.alloc(0),
        remoteAddress: request.selectedAddress,
      };
    },
  });
  const command = mediaWorkerCommand("reddit.post.text.create", {
    subreddit: "test", title: "Single attempt", text: "Body",
  }, "redirected-write");
  try {
    const result = await dispatcher.execute(command);
    assert.equal((result.error as any)?.submissionMayHaveStarted, true);
    assert.equal((result.error as any)?.retryable, false);
    const decoded = decodeWorkerMessage(result.message);
    assert.equal(decoded.type, "social-git.worker.result");
    if (decoded.type !== "social-git.worker.result") throw new Error("expected worker result");
    assert.equal(decoded.status, "UNKNOWN");
    result.message.fill(0);
    assert.deepEqual(redditCalls, ["/api/me.json", "/api/submit"]);
  } finally {
    command.fill(0);
  }
});

test("production session import consumes a private file only after encrypted Core persistence", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-import-"));
  const imports = join(root, "imports");
  const databasePath = join(root, "sessions.sqlite");
  mkdirSync(imports, { mode: 0o700 });
  const path = join(imports, "reddit-alpha.json");
  const sessionSentinel = "SYNTHETIC_SESSION_NOT_LIVE_8f02";
  const routeSentinel = "SYNTHETIC_ROUTE_NOT_LIVE_31c4";
  writeFileSync(path, JSON.stringify({
    sessionBase64: Buffer.from(JSON.stringify({ cookies: { reddit_session: sessionSentinel }, csrfToken: "synthetic-csrf" })).toString("base64url"),
    networkRoute: {
      id: "direct-route-alpha",
      materialBase64: Buffer.from(JSON.stringify({ kind: "direct", marker: routeSentinel })).toString("base64url"),
    },
  }), { mode: 0o600 });
  const runtime = new SessionRuntime({ databasePath, tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  try {
    const provider = new CoreRedditTransportProvider({ runtime, source: new DirectorySessionSource(imports) });
    await provider.importConnection({ account: account(), vaultHandle: "reddit-alpha", generation: 1 });
    assert.equal(existsSync(path), false);
    assert.equal(runtime.getAccountState("account-alpha").health, "pending_identity");

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT session_envelope, route_envelope FROM accounts WHERE account_id = ?").get("account-alpha") as Record<string, unknown>;
      const observable = JSON.stringify({
        session: JSON.parse(Buffer.from(row.session_envelope as Uint8Array).toString("utf8")),
        route: JSON.parse(Buffer.from(row.route_envelope as Uint8Array).toString("utf8")),
      });
      assert.equal(observable.includes(sessionSentinel), false);
      assert.equal(observable.includes(routeSentinel), false);
      assert.notEqual(JSON.parse(observable).session.binding.purpose, JSON.parse(observable).route.binding.purpose);
    } finally {
      database.close();
    }

    provider.revoke({ account: account() });
    const databaseAfterRevoke = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const revoked = databaseAfterRevoke.prepare("SELECT session_envelope, route_envelope FROM accounts WHERE account_id = ?")
        .get("account-alpha") as Record<string, unknown>;
      assert.equal(revoked.session_envelope, null);
      assert.equal(revoked.route_envelope, null);
    } finally {
      databaseAfterRevoke.close();
    }
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct owner upload encrypts in memory and supersedes the prior Core generation without plaintext staging", () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-direct-import-"));
  const databasePath = join(root, "sessions.sqlite");
  const runtime = new SessionRuntime({ databasePath, tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  const provider = new CoreRedditTransportProvider({
    runtime,
    source: { consume() { throw new Error("directory source must not be used"); } },
  });
  const firstSecret = "DIRECT_SESSION_SENTINEL_GENERATION_ONE";
  const secondSecret = "DIRECT_SESSION_SENTINEL_GENERATION_TWO";
  try {
    assert.equal(provider.nextConnectionGeneration(account()), 1);
    provider.importDirectConnection({
      account: account(),
      generation: 1,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: firstSecret }, csrfToken: "csrf-one" })),
      networkRoute: { id: "reddit-direct", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    const first = runtime.getAccountState("account-alpha");
    assert.equal(first.generation, 1);
    assert.equal(provider.nextConnectionGeneration(account()), 2);

    provider.importDirectConnection({
      account: account(),
      generation: 2,
      session: Buffer.from(JSON.stringify({ cookies: { reddit_session: secondSecret }, csrfToken: "csrf-two" })),
      networkRoute: { id: "reddit-direct", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
    });
    assert.equal(runtime.getAccountState("account-alpha").generation, 2);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT generation, session_envelope, route_envelope FROM accounts WHERE account_id = ?")
        .get("account-alpha") as Record<string, unknown>;
      const observable = JSON.stringify({
        generation: row.generation,
        session: JSON.parse(Buffer.from(row.session_envelope as Uint8Array).toString("utf8")),
        route: JSON.parse(Buffer.from(row.route_envelope as Uint8Array).toString("utf8")),
      });
      assert.equal(observable.includes(firstSecret), false);
      assert.equal(observable.includes(secondSecret), false);
      assert.equal(observable.includes("csrf-one"), false);
      assert.equal(observable.includes("csrf-two"), false);
    } finally {
      database.close();
    }
    assert.deepEqual(runtime.listAuditEvents().map((event) => event.eventType), ["session.imported", "session.rotated"]);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed one-time source commit revokes imported Core material", async () => {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-import-rollback-"));
  const session = Buffer.from("synthetic-session");
  const route = Buffer.from("synthetic-route");
  const runtime = new SessionRuntime({
    databasePath: join(root, "sessions.sqlite"),
    tenantId: "tenant-test",
    masterKey: randomBytes(32),
    auditKey: randomBytes(32),
  });
  try {
    const provider = new CoreRedditTransportProvider({
      runtime,
      source: {
        consume() {
          return {
            session,
            networkRoute: { id: "direct-route-alpha", material: route },
            commit() { throw new Error("synthetic commit failure"); },
          };
        },
      },
    });
    await assert.rejects(
      provider.importConnection({ account: account(), vaultHandle: "reddit-alpha", generation: 1 }),
      /synthetic commit failure/,
    );
    assert.equal(runtime.getAccountState("account-alpha").health, "revoked");
    assert.equal(session.every((value) => value === 0), true);
    assert.equal(route.every((value) => value === 0), true);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function account(): AccountRecord {
  return {
    id: "account-alpha",
    platform: "reddit",
    expectedNativeUserId: "reddit:t2_alpha",
    actualNativeUserId: null,
    label: null,
    status: "disconnected",
    connectionHealth: "disconnected",
    actionRequiredReason: null,
    healthGeneration: 0,
    lastVerifiedAt: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  };
}

async function providerHttpFixture(
  execute: (serialized: Uint8Array, call: number) => { message: Uint8Array; platformResult: { native: null; data: Record<string, unknown> } },
) {
  let calls = 0;
  const worker = createRedditWorkerHttpServer({
    commandKey: REDDIT_COMMAND_KEY,
    dispatcher: { execute: async (serialized) => execute(serialized, ++calls) },
  });
  await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const remote = new RemoteRedditCommandDispatcher(`http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1/dispatch`, REDDIT_COMMAND_KEY);
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-reddit-provider-"));
  const runtime = new SessionRuntime({ databasePath: join(root, "sessions.sqlite"), tenantId: "tenant-test", masterKey: randomBytes(32), auditKey: randomBytes(32) });
  const provider = new CoreRedditTransportProvider({ runtime, dispatcher: remote, source: { consume() { throw new Error("unused one-time source"); } } });
  return {
    worker,
    runtime,
    provider,
    calls: () => calls,
    async connect() {
      provider.importDirectConnection({
        account: account(), generation: 1,
        session: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic" }, csrfToken: "synthetic" })),
        networkRoute: { id: "direct-route-alpha", material: Buffer.from(JSON.stringify({ kind: "direct" })) },
      });
      await provider.execute({ account: account(), vaultHandle: "unused", intent: "identity_validation", operation: "profile.get", payload: {} });
    },
    async close() {
      runtime.close();
      remote.close();
      await new Promise<void>((resolve, reject) => worker.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function boundWorkerSuccess(command: any, overrides: Record<string, unknown> = {}) {
  return {
    message: encodeWorkerMessage({
      version: 1,
      type: "social-git.worker.result",
      requestId: command.requestId,
      tenantId: command.tenantId,
      accountId: command.accountId,
      platform: command.platform,
      generation: command.generation,
      leaseId: command.leaseId,
      fence: command.fence,
      status: "SUCCEEDED",
      observedNativeIdentity: command.expectedNativeIdentity,
      ...overrides,
    }),
    platformResult: { native: null, data: { accepted: true } },
  };
}

function mismatchedBinding(command: any, field: "requestId" | "leaseId" | "fence" | "accountId") {
  if (field === "fence") return { fence: command.fence + 1 };
  return { [field]: `${command[field]}-wrong` };
}

function workerResult(status: "SUCCEEDED" | "AUTH_FAILURE") {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: "request-1",
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    status,
    observedNativeIdentity: "reddit:t2_alpha",
  });
}

function dispatcherCommand() {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.command",
    requestId: "request-1",
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: "lease-1",
    fence: 1,
    expiresAt: Date.now() + 30_000,
    intent: "read",
    operation: "profile.get",
    expectedNativeIdentity: "reddit:t2_alpha",
    sessionBase64: Buffer.from("synthetic-session").toString("base64url"),
    networkRoute: { id: "direct-route-alpha", materialBase64: Buffer.from("synthetic-route").toString("base64url") },
    payload: {},
  });
}

function mediaWorkerCommand(operation: string, payload: Record<string, unknown>, requestId: string) {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.command",
    requestId,
    tenantId: "tenant-test",
    accountId: "account-alpha",
    platform: "reddit",
    generation: 1,
    leaseId: `lease-${requestId}`,
    fence: 1,
    expiresAt: Date.now() + 30_000,
    intent: "write",
    operation,
    expectedNativeIdentity: "t2_aliceid",
    sessionBase64: Buffer.from(JSON.stringify({ cookies: { reddit_session: "synthetic-not-live" }, csrfToken: "synthetic-modhash" })).toString("base64url"),
    networkRoute: { id: "direct-route-alpha", materialBase64: Buffer.from(JSON.stringify({ kind: "direct" })).toString("base64url") },
    payload,
  });
}

function redditMessage(overrides: Record<string, unknown>) {
  const id = String(overrides.id ?? "message1");
  return { id, name: `t4_${id}`, author: "bob", dest: "alice", subject: "Hello", body: "Body", new: true, created_utc: 1_800_000_000, parent_id: null, ...overrides };
}
