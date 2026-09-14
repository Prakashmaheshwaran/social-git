import { constants, lstatSync, fstatSync, openSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SessionRuntime,
  decodeWorkerMessage,
  encodeWorkerMessage,
  type WorkerCommand,
  type WorkerResultStatus,
} from "@social-git/core";
import {
  CORE_ERROR_CODES,
  RedditSessionTransport,
  RedditTransportError,
  createRedditSessionConnector,
  type RedditProductionResult,
} from "@social-git/reddit-adapter";
import { createRedditRouteAuthority } from "@social-git/worker-security";
import type { AccountRecord } from "./persistence.ts";
import type { RedditTransportProvider } from "./reddit-adapter.ts";

export interface ImportedSessionMaterial {
  session: Uint8Array;
  networkRoute: { id: string; material: Uint8Array };
  commit?(): Promise<void> | void;
}

export interface OneTimeSessionSource {
  consume(vaultHandle: string): Promise<ImportedSessionMaterial> | ImportedSessionMaterial;
}

export class DirectorySessionSource implements OneTimeSessionSource {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    assertPrivateDirectory(this.root);
  }

  consume(vaultHandle: string): ImportedSessionMaterial {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(vaultHandle)) {
      throw new TypeError("The vault handle must be a safe one-time import identifier");
    }
    const path = resolve(join(this.root, `${vaultHandle}.json`));
    if (!path.startsWith(`${this.root}${sep}`)) throw new TypeError("The vault handle is outside the import directory");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024 || (stat.mode & 0o077) !== 0) {
      throw new TypeError("The one-time import file is not a private bounded regular file");
    }
    const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || (opened.mode & 0o077) !== 0) {
        throw new TypeError("The one-time import file changed before it could be read");
      }
      bytes = readFileSync(descriptor);
    } finally { closeSync(descriptor); }
    let session: Buffer | undefined;
    let material: Buffer | undefined;
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      session = decodeCanonicalBase64(parsed.sessionBase64, 48 * 1024, "sessionBase64");
      const route = record(parsed.networkRoute, "networkRoute");
      const id = boundedString(route.id, "networkRoute.id", 128);
      material = decodeCanonicalBase64(route.materialBase64, 16 * 1024, "networkRoute.materialBase64");
      const expectedDevice = stat.dev;
      const expectedInode = stat.ino;
      return {
        session,
        networkRoute: { id, material },
        commit() {
          const current = lstatSync(path);
          if (current.dev !== expectedDevice || current.ino !== expectedInode || !current.isFile() || current.isSymbolicLink()) {
            throw new TypeError("The one-time import file changed before it could be consumed");
          }
          unlinkSync(path);
        },
      };
    } catch (error) {
      session?.fill(0);
      material?.fill(0);
      throw error;
    } finally {
      bytes.fill(0);
    }
  }
}

export interface RedditCommandExecution {
  message: Uint8Array;
  platformResult?: RedditProductionResult;
  error?: unknown;
}

export class ProductionRedditCommandDispatcher {
  async execute(serialized: Uint8Array): Promise<RedditCommandExecution> {
    const command = decodeWorkerMessage(serialized);
    if (command.type !== "social-git.worker.command" || command.platform !== "reddit") {
      throw new TypeError("A bound Reddit worker command is required");
    }
    const sessionBytes = Buffer.from(command.sessionBase64, "base64url");
    const routeBytes = Buffer.from(command.networkRoute.materialBase64, "base64url");
    let observedNativeIdentity = command.expectedNativeIdentity;
    try {
      const session = parseSession(sessionBytes);
      const route = record(JSON.parse(routeBytes.toString("utf8")), "network route material");
      if (route.kind !== "direct" || Object.keys(route).some((key) => key !== "kind")) {
        throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The configured Reddit network route is not admitted");
      }
      const connectorId = `reddit:${command.accountId}:${command.generation}`;
      const connector = createRedditSessionConnector(session);
      const authority = createRedditRouteAuthority({
        routes: [{
          id: command.networkRoute.id,
          tenantId: command.tenantId,
          accountId: command.accountId,
          generation: command.generation,
          connectorId,
        }],
        connectors: { [connectorId]: connector },
        resolver: resolvePublicAddresses,
      });
      const transport = new RedditSessionTransport({
        routeAuthority: authority,
        binding: {
          tenantId: command.tenantId,
          accountId: command.accountId,
          routeId: command.networkRoute.id,
          generation: command.generation,
        },
        expectedNativeIdentity: command.expectedNativeIdentity,
      });
      const operation = transportOperation(command.operation);
      const payload = commandPayload(command);
      const result = operation === "profile.get"
        ? await transport.verifyIdentity()
        : await transport.execute(operation as never, payload, {
          actionId: command.requestId,
          callerId: command.requestId,
          idempotencyKey: command.requestId,
        });
      observedNativeIdentity = observedIdentity(command.expectedNativeIdentity, result);
      return {
        message: workerResult(command, "SUCCEEDED", observedNativeIdentity, result.native ?? undefined),
        platformResult: result,
      };
    } catch (error) {
      return { message: workerResult(command, workerStatus(error), observedNativeIdentity), error };
    } finally {
      sessionBytes.fill(0);
      routeBytes.fill(0);
      command.sessionBase64 = "REDACTED";
      command.networkRoute.materialBase64 = "REDACTED";
    }
  }

  async dispatch(serialized: Uint8Array): Promise<Uint8Array> {
    return (await this.execute(serialized)).message;
  }
}

export class CoreRedditTransportProvider implements RedditTransportProvider {
  private readonly runtime: SessionRuntime;
  private readonly source: OneTimeSessionSource;
  private readonly dispatcher: ProductionRedditCommandDispatcher;

  constructor(options: { runtime: SessionRuntime; source: OneTimeSessionSource; dispatcher?: ProductionRedditCommandDispatcher }) {
    this.runtime = options.runtime;
    this.source = options.source;
    this.dispatcher = options.dispatcher ?? new ProductionRedditCommandDispatcher();
  }

  async importConnection(input: { account: AccountRecord; vaultHandle: string; generation: number }) {
    const material = await this.source.consume(input.vaultHandle);
    let imported = false;
    try {
      this.runtime.importExternalSession({
        accountId: input.account.id,
        platform: input.account.platform,
        expectedNativeIdentity: input.account.expectedNativeUserId,
        generation: input.generation,
        session: material.session,
        networkRoute: material.networkRoute,
      });
      imported = true;
      await material.commit?.();
    } catch (error) {
      if (imported) {
        try {
          this.runtime.revokeAccount({ accountId: input.account.id, generation: input.generation });
        } catch { /* Keep the original one-time import failure. */ }
      }
      throw error;
    } finally {
      material.session.fill(0);
      material.networkRoute.material.fill(0);
    }
  }

  async execute(input: {
    account: AccountRecord;
    vaultHandle: string;
    intent: "identity_validation" | "read" | "write";
    operation: string;
    payload: Record<string, unknown>;
  }): Promise<RedditProductionResult> {
    const state = this.runtime.getAccountState(input.account.id);
    const command = this.runtime.acquireWorkerCommand({
      accountId: input.account.id,
      generation: state.generation,
      requestId: `adapter-${randomUUID()}`,
      intent: input.intent,
      operation: input.operation,
      payload: input.payload,
    });
    const executed = await this.dispatcher.execute(command);
    try {
      this.runtime.completeWorkerResult({ accountId: input.account.id, generation: state.generation, message: executed.message });
    } catch (error) {
      throw executed.error ?? error;
    } finally {
      command.fill(0);
      executed.message.fill(0);
    }
    if (executed.error) throw executed.error;
    if (!executed.platformResult) throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit worker returned no platform result");
    return executed.platformResult;
  }

  revoke(input: { account: AccountRecord }) {
    try {
      const state = this.runtime.getAccountState(input.account.id);
      if (state.health !== "revoked") this.runtime.revokeAccount({ accountId: input.account.id, generation: state.generation });
    } catch (error) {
      if ((error as { code?: string })?.code !== "NOT_FOUND" && (error as { code?: string })?.code !== "REVOKED") throw error;
    }
  }
}

function commandPayload(command: WorkerCommand): Record<string, unknown> {
  const payload = command.intent === "write" && command.payload && typeof command.payload === "object" && "action" in command.payload
    ? record((command.payload as Record<string, unknown>).action, "action payload")
    : record(command.payload ?? {}, "worker payload");
  switch (command.operation) {
    case "reddit.post.text.create":
      return { subreddit: payload.subreddit, title: payload.title, body: payload.text };
    case "reddit.post.link.create":
      return { subreddit: payload.subreddit, title: payload.title, url: payload.url };
    case "reddit.post.media.create":
      return { subreddit: payload.subreddit, title: payload.title, mediaRef: payload.mediaRef };
    case "reddit.comment.create":
      return { postNativeId: redditFullname(payload.postId, "t3"), body: payload.text };
    case "reddit.comment.reply":
      return { commentNativeId: redditFullname(payload.commentId, "t1"), body: payload.text };
    case "reddit.vote.set":
      return { nativeId: redditItemFullname(payload.targetId), direction: payload.direction };
    case "reddit.item.save":
    case "reddit.item.unsave":
    case "reddit.item.delete":
      return { nativeId: redditItemFullname(payload.targetId) };
    default:
      return payload;
  }
}

function redditFullname(value: unknown, prefix: "t1" | "t3") {
  const input = boundedString(value, `${prefix} native ID`, 128);
  return input.startsWith(`${prefix}_`) ? input : `${prefix}_${input}`;
}

function redditItemFullname(value: unknown) {
  const input = boundedString(value, "item native ID", 128);
  if (!/^t[13]_[a-z0-9]+$/u.test(input)) throw new TypeError("The Reddit item native ID is invalid");
  return input;
}

function transportOperation(operation: string): string {
  return ({
    "reddit.post.text.create": "post.createText",
    "reddit.post.link.create": "post.createLink",
    "reddit.post.media.create": "post.createMedia",
    "reddit.comment.create": "comment.create",
    "reddit.comment.reply": "reply.create",
    "reddit.vote.set": "vote.set",
    "reddit.item.save": "save.set",
    "reddit.item.unsave": "save.unset",
    "reddit.item.delete": "item.deleteOwn",
  } as Record<string, string>)[operation] ?? operation;
}

function workerResult(
  command: WorkerCommand,
  status: WorkerResultStatus,
  observed: string,
  native?: { nativeId: string; canonicalUrl?: string },
): Uint8Array {
  return encodeWorkerMessage({
    version: 1,
    type: "social-git.worker.result",
    requestId: command.requestId,
    tenantId: command.tenantId,
    accountId: command.accountId,
    platform: command.platform,
    generation: command.generation,
    leaseId: command.leaseId,
    fence: command.fence,
    status,
    observedNativeIdentity: observed,
    ...(native?.nativeId ? { nativeId: native.nativeId } : {}),
    ...(native?.canonicalUrl ? { canonicalUrl: native.canonicalUrl } : {}),
  });
}

function workerStatus(error: unknown): WorkerResultStatus {
  const code = (error as { code?: string })?.code;
  if (code === CORE_ERROR_CODES.AUTHENTICATION_FAILED) return "AUTH_FAILURE";
  if (code === CORE_ERROR_CODES.CHALLENGE_REQUIRED) return "CHALLENGE";
  if (code === CORE_ERROR_CODES.CHECKPOINT_REQUIRED) return "CHECKPOINT";
  if (code === CORE_ERROR_CODES.CAPTCHA_REQUIRED) return "CAPTCHA";
  if (code === CORE_ERROR_CODES.RATE_LIMITED) return "RATE_LIMITED";
  if (code === CORE_ERROR_CODES.SESSION_REVOKED) return "REVOKED";
  if ((error as { submissionMayHaveStarted?: boolean })?.submissionMayHaveStarted) return "UNKNOWN";
  return "PROTOCOL_DRIFT";
}

function observedIdentity(expected: string, result: RedditProductionResult): string {
  const nativeId = result.native?.nativeId;
  return expected.replace(/^reddit:/u, "") === nativeId ? expected : String(nativeId ?? "unknown");
}

function parseSession(bytes: Uint8Array) {
  const input = record(JSON.parse(Buffer.from(bytes).toString("utf8")), "session material");
  const cookies = record(input.cookies, "session cookies");
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(cookies)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name) || typeof value !== "string" || value.length < 1 || value.length > 8192) {
      throw new TypeError("Session cookies are invalid");
    }
    normalized[name] = value;
  }
  if (Object.keys(normalized).length < 1 || Object.keys(normalized).length > 64) throw new TypeError("Session cookies are invalid");
  const csrfToken = boundedString(input.csrfToken, "csrfToken", 8192);
  const userAgent = input.userAgent === undefined ? undefined : boundedString(input.userAgent, "userAgent", 512);
  return { cookies: normalized, csrfToken, ...(userAgent ? { userAgent } : {}) };
}

async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) throw new Error("The admitted Reddit host did not resolve");
  return addresses;
}

function assertPrivateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new TypeError("The session import directory must be private and must not be a symbolic link");
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function decodeCanonicalBase64(value: unknown, maximum: number, name: string): Buffer {
  const encoded = boundedString(value, name, maximum * 2);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new TypeError(`${name} is invalid`);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length < 1 || decoded.length > maximum || decoded.toString("base64url") !== encoded) {
    decoded.fill(0);
    throw new TypeError(`${name} is invalid`);
  }
  return decoded;
}
