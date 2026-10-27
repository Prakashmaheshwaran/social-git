import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import type { PlatformAdapter } from "../src/adapter.ts";
import {
  createSocialGitHttpServer,
  IdentityHttpController,
  IdentityStore,
  LedgerStore,
  OwnerRedditSessionImportController,
  OwnerXSessionImportController,
  SocialGitService,
} from "../src/index.ts";
import { tempDatabase } from "./helpers.ts";

/**
 * Platform-boundary matrix for the owner session-import route.
 *
 * These assertions are deliberately duplicated per platform so that a future
 * shared implementation must keep every rejection path, status, error code,
 * message, size bound, and wipe-on-finally identical for both Reddit and X.
 * The two per-platform suites in reddit-session-import.test.ts and
 * x-session-import.test.ts cover the custody/admission narratives; this file
 * pins the wire contract that the two controllers currently copy-paste.
 */

const MAX_IMPORT_BYTES = 24 * 1024;

class CapturingImportAdapter implements PlatformAdapter {
  readonly platform: "reddit" | "x";
  readonly directSessionIdentityVerificationAdmitted?: boolean;
  nativeIdentity: string;
  generation = 0;
  capturedSession: Uint8Array | null = null;
  capturedRoute: Uint8Array | null = null;
  prepared = 0;
  revoked = 0;
  verified = 0;

  constructor(platform: "reddit" | "x", nativeIdentity: string, admitted?: boolean) {
    this.platform = platform;
    this.nativeIdentity = nativeIdentity;
    this.directSessionIdentityVerificationAdmitted = admitted;
  }

  nextConnectionGeneration() { this.generation += 1; return this.generation; }
  prepareDirectConnection(input: { session: Uint8Array; networkRoute: { material: Uint8Array } }) {
    this.prepared += 1;
    this.capturedSession = input.session;
    this.capturedRoute = input.networkRoute.material;
  }
  async capabilities() { return []; }
  async verifyIdentity() { this.verified += 1; return { nativeUserId: this.nativeIdentity }; }
  async read() { throw new Error("not used"); }
  async submit() { return { status: "failed" as const, code: "CAPABILITY_UNAVAILABLE", message: "not used" }; }
  async reconcile() { return { status: "pending" as const }; }
  async revoke() { this.revoked += 1; }
}

interface PlatformCase {
  platform: "reddit" | "x";
  route: "reddit-session" | "x-session";
  label: "Reddit" | "X";
  schemaMessage: string;
  expectedNativeUserId: string;
  admitted?: boolean;
  secretField: "redditSessionCookie" | "auth_token";
  extraSecretField?: "csrfToken" | "ct0";
  valid: Record<string, unknown>;
  foreignPlatform: string;
  sentinels: string[];
}

const CASES: PlatformCase[] = [
  {
    platform: "reddit",
    route: "reddit-session",
    label: "Reddit",
    schemaMessage: "The session file must use the Reddit session export v1 schema.",
    expectedNativeUserId: "native-user-1",
    secretField: "redditSessionCookie",
    extraSecretField: "csrfToken",
    valid: {
      version: 1,
      platform: "reddit",
      expectedNativeUserId: "native-user-1",
      redditSessionCookie: "reddit-cookie-sentinel-4f1a",
      csrfToken: "reddit-csrf-sentinel-9c2b",
    },
    foreignPlatform: "x",
    sentinels: ["reddit-cookie-sentinel-4f1a", "reddit-csrf-sentinel-9c2b"],
  },
  {
    platform: "x",
    route: "x-session",
    label: "X",
    schemaMessage: "The session file must use the X session export schema.",
    expectedNativeUserId: "123456789",
    admitted: true,
    secretField: "auth_token",
    extraSecretField: "ct0",
    valid: {
      platform: "x",
      expectedNativeUserId: "123456789",
      auth_token: "x-auth-sentinel-77d3",
      ct0: "x-ct0-sentinel-5ea8",
    },
    foreignPlatform: "twitter",
    sentinels: ["x-auth-sentinel-77d3", "x-ct0-sentinel-5ea8"],
  },
];

interface Fixture {
  base: string;
  path: string;
  adapter: CapturingImportAdapter;
  store: LedgerStore;
  identity: IdentityStore;
  ownerToken: string;
  ownerCsrf: string;
  memberToken: string;
  memberCsrf: string;
  apiKeySecret: string;
  close(): Promise<void>;
}

async function fixtureFor(spec: PlatformCase): Promise<Fixture> {
  const files = tempDatabase();
  const identity = new IdentityStore(files.path, { tenantId: "tenant-alpha" });
  const ownerSession = identity.createFirstOwner({
    email: "owner@example.com",
    displayName: "Owner",
    password: "owner-password-42!",
  });
  const member = identity.provisionUser(ownerSession.principal, {
    email: "member@example.com",
    displayName: "Member",
    password: "member-password-42!",
    role: "member",
  });
  const memberSession = identity.login({ email: member.email, password: "member-password-42!" })!;
  const apiKey = identity.createApiKey(ownerSession.principal, { name: "boundary-probe", scopes: ["connections:write"] });
  const identityController = new IdentityHttpController(identity, false);
  const adapter = new CapturingImportAdapter(spec.platform, spec.expectedNativeUserId, spec.admitted);
  const store = new LedgerStore(":memory:");
  const service = new SocialGitService({ store, adapters: [adapter], tenantId: "tenant-alpha" });
  const created = await service.createAccount(ownerSession.principal, {
    platform: spec.platform,
    expectedNativeUserId: spec.expectedNativeUserId,
  });
  const controller = spec.platform === "reddit"
    ? new OwnerRedditSessionImportController(service, (request) => identityController.authenticateRequest(request, true, false))
    : new OwnerXSessionImportController(service, (request) => identityController.authenticateRequest(request, true, false));
  const server = createSocialGitHttpServer({
    service,
    identity: identityController,
    ownerSessionImport: controller,
    authenticate: (request) => identityController.authenticateRequest(request),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    path: `/v1/control-plane/accounts/${created.account.id}/${spec.route}`,
    adapter,
    store,
    identity,
    ownerToken: ownerSession.token,
    ownerCsrf: ownerSession.csrfToken,
    memberToken: memberSession.token,
    memberCsrf: memberSession.csrfToken,
    apiKeySecret: apiKey.secret,
    async close() {
      server.close();
      await once(server, "close");
      store.close();
      identity.close();
      files.cleanup();
    },
  };
}

function ownerHeaders(fixture: Fixture) {
  return {
    cookie: `social_git_session=${fixture.ownerToken}`,
    "x-csrf-token": fixture.ownerCsrf,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
}

/**
 * Streaming upload with no content-length, so only the 24 KiB streaming bound
 * can reject it. Written over a raw node request because fetch() aborts the
 * socket with ECONNRESET as soon as the server answers early; the wire result
 * we care about is the HTTP status the controller actually sent.
 */
function streamedUpload(base: string, path: string, headers: Record<string, string>, chunkCount: number): Promise<{ status: number; text: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      method: "POST",
      headers: { ...headers, "transfer-encoding": "chunked" },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on("error", reject);
    let sent = 0;
    const pump = () => {
      if (request.destroyed) return;
      if (sent === chunkCount) { request.end(); return; }
      sent += 1;
      request.write(Buffer.alloc(1024, 97), (error) => {
        if (error) { request.destroy(); return; }
        pump();
      });
    };
    pump();
  });
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string | undefined>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function expectError(result: { status: number; text: string }, status: number, code: string, message: string, sentinels: string[]) {
  assert.equal(result.status, status, result.text);
  const body = JSON.parse(result.text) as { error: { code: string; message: string; requestId: string } };
  assert.equal(body.error.code, code);
  assert.equal(body.error.message, message);
  assert.equal(typeof body.error.requestId, "string");
  expectNoEcho(result.text, sentinels);
}

function expectNoEcho(text: string, sentinels: string[]) {
  for (const sentinel of sentinels) assert.equal(text.includes(sentinel), false, `response echoed ${sentinel}`);
}

function expectWiped(adapter: CapturingImportAdapter) {
  assert.ok(adapter.capturedSession, "the import never reached the adapter");
  assert.ok(adapter.capturedRoute, "the import never reached the adapter");
  assert.ok(adapter.capturedSession.every((byte) => byte === 0), "session buffer was retained after the request");
  assert.ok(adapter.capturedRoute.every((byte) => byte === 0), "network-route buffer was retained after the request");
}

for (const spec of CASES) {
  test(`${spec.label}: the owner session-import route accepts only a bounded same-origin JSON browser upload`, async () => {
    const fixture = await fixtureFor(spec);
    const headers = ownerHeaders(fixture);
    try {
      // content-type gate: 415 before the body is ever read.
      for (const contentType of [undefined, "text/plain", "application/octet-stream", "application/jsonx"]) {
        const result = await post(fixture.base, fixture.path, spec.valid, { ...headers, "content-type": contentType });
        expectError(result, 415, "VALIDATION_FAILED", `Upload the explicitly exported ${spec.label} session JSON file.`, spec.sentinels);
      }

      // Declared size gate: content-length is rejected before the body is read.
      const declaredOversize = await fetch(`${fixture.base}${fixture.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...spec.valid, [spec.secretField]: "a".repeat(MAX_IMPORT_BYTES) }),
      });
      expectError(
        { status: declaredOversize.status, text: await declaredOversize.text() },
        413,
        "VALIDATION_FAILED",
        `Session file exceeds the ${MAX_IMPORT_BYTES} byte limit.`,
        spec.sentinels,
      );

      // Streamed size gate: no content-length, so the streaming bound must stop it.
      const streamedOversize = await streamedUpload(fixture.base, fixture.path, headers, 40);
      expectError(streamedOversize, 413, "VALIDATION_FAILED", `Session file exceeds the ${MAX_IMPORT_BYTES} byte limit.`, spec.sentinels);

      // Browser-session-only gate: no bearer credential of any kind may be used.
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, authorization: `Bearer ${fixture.apiKeySecret}` }),
        403,
        "FORBIDDEN",
        "Social-session import accepts only the signed-in owner browser session.",
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, authorization: "Bearer not-a-real-key" }),
        403,
        "FORBIDDEN",
        "Social-session import accepts only the signed-in owner browser session.",
        spec.sentinels,
      );

      // Same-origin gate.
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, "sec-fetch-site": "cross-site" }),
        403,
        "FORBIDDEN",
        "Social-session import requires a same-origin browser request.",
        spec.sentinels,
      );

      // Owner role and fresh CSRF gates.
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, cookie: `social_git_session=${fixture.memberToken}`, "x-csrf-token": fixture.memberCsrf }),
        403,
        "FORBIDDEN",
        "Only the signed-in owner can import a social session.",
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, cookie: undefined }),
        401,
        "UNAUTHENTICATED",
        "A valid owner session and fresh CSRF token are required.",
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, "x-csrf-token": undefined }),
        401,
        "UNAUTHENTICATED",
        "A valid owner session and fresh CSRF token are required.",
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, "x-csrf-token": "too-short" }),
        401,
        "UNAUTHENTICATED",
        "A valid owner session and fresh CSRF token are required.",
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, spec.valid, { ...headers, "x-csrf-token": "A".repeat(64) }),
        401,
        "UNAUTHENTICATED",
        "A valid owner session and fresh CSRF token are required.",
        spec.sentinels,
      );

      // The rejected requests never reached custody.
      assert.equal(fixture.adapter.prepared, 0);
    } finally {
      await fixture.close();
    }
  });

  test(`${spec.label}: the owner session-import route rejects malformed, unbounded, and unknown-shape payloads`, async () => {
    const fixture = await fixtureFor(spec);
    const headers = ownerHeaders(fixture);
    try {
      expectError(
        await post(fixture.base, fixture.path, "", headers),
        422,
        "VALIDATION_FAILED",
        `The exported ${spec.label} session file is empty.`,
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, "{not json", headers),
        422,
        "VALIDATION_FAILED",
        `The exported ${spec.label} session file must be valid JSON.`,
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, [], headers),
        422,
        "VALIDATION_FAILED",
        `The exported ${spec.label} session file must be a plain JSON object.`,
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, { ...spec.valid, cookies: {} }, headers),
        422,
        "VALIDATION_FAILED",
        `The exported ${spec.label} session file contains missing or unsupported fields.`,
        spec.sentinels,
      );
      const missing = Object.fromEntries(Object.entries(spec.valid).filter(([key]) => key !== spec.secretField));
      expectError(
        await post(fixture.base, fixture.path, missing, headers),
        422,
        "VALIDATION_FAILED",
        `The exported ${spec.label} session file contains missing or unsupported fields.`,
        spec.sentinels,
      );
      expectError(
        await post(fixture.base, fixture.path, { ...spec.valid, platform: spec.foreignPlatform }, headers),
        422,
        "VALIDATION_FAILED",
        spec.schemaMessage,
        spec.sentinels,
      );

      // The account id in the path is decoded and bounded before custody.
      const badAccount = `/v1/control-plane/accounts/${encodeURIComponent("bad id")}/${spec.route}`;
      expectError(
        await post(fixture.base, badAccount, spec.valid, headers),
        422,
        "VALIDATION_FAILED",
        "accountId is invalid.",
        spec.sentinels,
      );

      // Non-POST methods do not exist on this route.
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await fetch(`${fixture.base}${fixture.path}`, { method, headers });
        expectError(
          { status: response.status, text: await response.text() },
          404,
          "NOT_FOUND",
          "Route not found.",
          spec.sentinels,
        );
      }
      assert.equal(fixture.adapter.prepared, 0);
    } finally {
      await fixture.close();
    }
  });

  test(`${spec.label}: a successful owner session import is admitted, wiped, and never echoed`, async () => {
    const fixture = await fixtureFor(spec);
    const headers = ownerHeaders(fixture);
    try {
      const accepted = await post(fixture.base, fixture.path, spec.valid, headers);
      assert.equal(accepted.status, spec.admitted === false ? 202 : 201, accepted.text);
      expectNoEcho(accepted.text, spec.sentinels);
      const body = JSON.parse(accepted.text) as { connection?: { generation?: number }; admission?: { state: string } };
      if (spec.admitted === false) {
        assert.equal(body.admission?.state, "action_required");
        assert.equal(body.connection, null);
      } else {
        assert.equal(body.connection?.generation, 1);
      }
      assert.equal(fixture.adapter.prepared, 1);
      expectWiped(fixture.adapter);

      // No durable surface may retain the uploaded material.
      const observable = JSON.stringify({
        audit: fixture.store.listAuditEvents({ limit: 100 }),
        accounts: fixture.store.listAccounts(),
      });
      expectNoEcho(observable, spec.sentinels);
    } finally {
      await fixture.close();
    }
  });

  test(`${spec.label}: a rejected owner session import still wipes the staged material`, async () => {
    const fixture = await fixtureFor(spec);
    const headers = ownerHeaders(fixture);
    try {
      fixture.adapter.nativeIdentity = "some-other-native-identity";
      const mismatch = await post(fixture.base, fixture.path, spec.valid, headers);
      expectError(
        mismatch,
        409,
        "WRONG_IDENTITY",
        "The native account identity does not match the account binding.",
        spec.sentinels,
      );
      assert.equal(fixture.adapter.prepared, 1);
      assert.equal(fixture.adapter.revoked, 1);
      expectWiped(fixture.adapter);
    } finally {
      await fixture.close();
    }
  });
}

test("X keeps its own admission status: an unadmitted transport is 202, not 201", async () => {
  const spec = CASES[1]!;
  const fixture = await fixtureFor({ ...spec, admitted: false });
  const headers = ownerHeaders(fixture);
  try {
    const accepted = await post(fixture.base, fixture.path, spec.valid, headers);
    assert.equal(accepted.status, 202);
    assert.equal((JSON.parse(accepted.text) as any).admission.code, "X_TRANSPORT_NOT_ADMITTED");
    expectNoEcho(accepted.text, spec.sentinels);
    expectWiped(fixture.adapter);
  } finally {
    await fixture.close();
  }
});

test("Reddit keeps its own admission status: a verified direct import is 201", async () => {
  const spec = CASES[0]!;
  const fixture = await fixtureFor(spec);
  const headers = ownerHeaders(fixture);
  try {
    const accepted = await post(fixture.base, fixture.path, spec.valid, headers);
    assert.equal(accepted.status, 201);
    assert.equal((JSON.parse(accepted.text) as any).connection.generation, 1);
    expectNoEcho(accepted.text, spec.sentinels);
    expectWiped(fixture.adapter);
  } finally {
    await fixture.close();
  }
});
