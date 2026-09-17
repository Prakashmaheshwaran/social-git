import { constants, lstatSync, fstatSync, openSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
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
import {
  createPinnedHttpsConnector,
  createRedditMediaUploadAuthority,
  createRedditRouteAuthority,
  receiveRedditMediaProcessMessage,
} from "@social-git/worker-security";
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

export interface RedditCommandDispatcher {
  execute(serialized: Uint8Array): Promise<RedditCommandExecution>;
}

interface MediaMetadata {
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  sizeBytes: number;
  sha256: string;
}

interface MediaWorkerTicket {
  ticket: string;
  accountId: string;
  generation: number;
  routeId: string;
  phase: "leased" | "uploaded" | "submitted";
  metadata: MediaMetadata;
  lease: Awaited<ReturnType<RedditSessionTransport["leaseMedia"]>>;
  websocketUrl: string | null;
  expiresAt: number;
}

export class ProductionRedditCommandDispatcher {
  private readonly mediaTickets = new Map<string, MediaWorkerTicket>();
  private readonly now: () => number;
  private readonly resolver: typeof resolvePublicAddresses;
  private readonly uploadMedia: typeof uploadRedditMedia;
  private readonly processMedia: typeof processRedditMedia;
  private readonly sessionConnectorFactory: typeof createRedditSessionConnector;

  constructor(options: {
    now?: () => number;
    resolver?: typeof resolvePublicAddresses;
    uploadMedia?: typeof uploadRedditMedia;
    processMedia?: typeof processRedditMedia;
    sessionConnectorFactory?: typeof createRedditSessionConnector;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.resolver = options.resolver ?? resolvePublicAddresses;
    this.uploadMedia = options.uploadMedia ?? uploadRedditMedia;
    this.processMedia = options.processMedia ?? processRedditMedia;
    this.sessionConnectorFactory = options.sessionConnectorFactory ?? createRedditSessionConnector;
  }

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
      const connector = this.sessionConnectorFactory(session);
      const authority = createRedditRouteAuthority({
        routes: [{
          id: command.networkRoute.id,
          tenantId: command.tenantId,
          accountId: command.accountId,
          generation: command.generation,
          connectorId,
        }],
        connectors: { [connectorId]: connector },
        resolver: this.resolver,
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
      const payload = commandPayload(command);
      const operation = transportOperation(command.operation);
      const result = command.operation.startsWith("reddit.post.media.")
        ? await this.executeMedia(command, transport, payload)
        : operation === "profile.get"
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

  private async executeMedia(
    command: WorkerCommand,
    transport: RedditSessionTransport,
    payload: Record<string, unknown>,
  ): Promise<RedditProductionResult> {
    this.expireMediaTickets();
    await transport.verifyIdentity();
    if (command.operation === "reddit.post.media.create") {
      return this.executeCompleteMedia(command, transport, payload);
    }
    if (command.operation === "reddit.post.media.lease") {
      if (this.mediaTickets.size >= 128) {
        throw new RedditTransportError(CORE_ERROR_CODES.WORKER_UNAVAILABLE!, "The bounded Reddit media lease set is full", { retryable: true });
      }
      const metadata = mediaMetadata(payload);
      const lease = await transport.leaseMedia(metadata, { actionId: command.requestId });
      const ticket = randomUUID();
      this.mediaTickets.set(ticket, {
        ticket,
        accountId: command.accountId,
        generation: command.generation,
        routeId: command.networkRoute.id,
        phase: "leased",
        metadata,
        lease,
        websocketUrl: null,
        expiresAt: this.now() + 5 * 60_000,
      });
      return mediaPhaseResult(ticket, lease.rateLimit);
    }
    const ticket = this.boundMediaTicket(command, payload.ticket);
    if (command.operation === "reddit.post.media.upload") {
      if (ticket.phase !== "leased") throw mediaTicketError("The Reddit media ticket is not ready for upload");
      const data = mediaBytes(payload, ticket.metadata);
      try {
        await this.uploadMedia({
          binding: {
            tenantId: command.tenantId,
            accountId: command.accountId,
            routeId: command.networkRoute.id,
            generation: command.generation,
          },
          uploadUrl: ticket.lease.uploadUrl,
          fields: ticket.lease.fields,
          filename: ticket.metadata.filename,
          mimeType: ticket.metadata.mimeType,
          data,
          resolver: this.resolver,
          deadlineEpochMs: this.now() + 60_000,
        });
        ticket.phase = "uploaded";
        return mediaPhaseResult(ticket.ticket);
      } catch (error) {
        if (error instanceof RedditTransportError) throw error;
        throw new RedditTransportError(CORE_ERROR_CODES.WORKER_UNAVAILABLE!, "The Reddit media upload failed before submission", { retryable: true });
      } finally {
        data.fill(0);
      }
    }
    if (command.operation === "reddit.post.media.submit") {
      if (ticket.phase !== "uploaded") throw mediaTicketError("The Reddit media ticket is not ready for submission");
      try {
        const submitted = await transport.submitMedia({
          subreddit: boundedString(payload.subreddit, "subreddit", 21),
          title: boundedString(payload.title, "title", 300),
          mediaUrl: ticket.lease.mediaUrl,
        }, { actionId: command.requestId });
        ticket.websocketUrl = submitted.websocketUrl;
        ticket.phase = "submitted";
        return mediaPhaseResult(ticket.ticket, submitted.rateLimit);
      } catch (error) {
        throw submissionError(error);
      }
    }
    if (command.operation === "reddit.post.media.process") {
      if (ticket.phase !== "submitted" || !ticket.websocketUrl) throw submissionError(mediaTicketError("The Reddit media ticket is not ready for processing"));
      try {
        const result = await this.processMedia({
          websocketUrl: ticket.websocketUrl,
          resolver: this.resolver,
          deadlineEpochMs: this.now() + 60_000,
        });
        this.mediaTickets.delete(ticket.ticket);
        return result;
      } catch (error) {
        throw submissionError(error);
      }
    }
    throw mediaTicketError("The Reddit media phase operation is not admitted");
  }

  private async executeCompleteMedia(
    command: WorkerCommand,
    transport: RedditSessionTransport,
    payload: Record<string, unknown>,
  ): Promise<RedditProductionResult> {
    const media = record(payload.media, "Core media");
    const metadata = mediaMetadata(media);
    const data = mediaBytes(media, metadata);
    try {
      const lease = await transport.leaseMedia(metadata, { actionId: `${command.requestId}:lease` });
      await this.uploadMedia({
        binding: {
          tenantId: command.tenantId,
          accountId: command.accountId,
          routeId: command.networkRoute.id,
          generation: command.generation,
        },
        uploadUrl: lease.uploadUrl,
        fields: lease.fields,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        data,
        resolver: this.resolver,
        deadlineEpochMs: this.now() + 60_000,
      });
      let submitted;
      try {
        submitted = await transport.submitMedia({
          subreddit: boundedString(payload.subreddit, "subreddit", 21),
          title: boundedString(payload.title, "title", 300),
          mediaUrl: lease.mediaUrl,
        }, { actionId: `${command.requestId}:submit` });
      } catch (error) {
        throw submissionError(error);
      }
      try {
        return await this.processMedia({
          websocketUrl: submitted.websocketUrl,
          resolver: this.resolver,
          deadlineEpochMs: this.now() + 60_000,
        });
      } catch (error) {
        throw submissionError(error);
      }
    } finally {
      data.fill(0);
    }
  }

  private boundMediaTicket(command: WorkerCommand, value: unknown) {
    const id = boundedString(value, "media ticket", 128);
    const ticket = this.mediaTickets.get(id);
    if (!ticket || ticket.expiresAt <= this.now() || ticket.accountId !== command.accountId
      || ticket.generation !== command.generation || ticket.routeId !== command.networkRoute.id) {
      if (ticket) this.mediaTickets.delete(id);
      throw mediaTicketError("The Reddit media ticket is expired or wrongly bound");
    }
    ticket.expiresAt = this.now() + 5 * 60_000;
    return ticket;
  }

  private expireMediaTickets() {
    const timestamp = this.now();
    for (const [id, ticket] of this.mediaTickets) {
      if (ticket.expiresAt <= timestamp) this.mediaTickets.delete(id);
    }
  }
}

export class RemoteRedditCommandDispatcher implements RedditCommandDispatcher {
  private readonly url: string;
  private readonly readinessUrl: string;

  constructor(url: string) {
    this.url = url;
    this.readinessUrl = new URL("/readyz", url).toString();
  }

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(this.readinessUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async execute(serialized: Uint8Array): Promise<RedditCommandExecution> {
    let submissionMayHaveStarted = true;
    try {
      const command = decodeWorkerMessage(serialized);
      submissionMayHaveStarted = command.type === "social-git.worker.command"
        && command.intent === "write"
        && !["reddit.post.media.lease", "reddit.post.media.upload"].includes(command.operation);
    } catch {
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit worker command failed validation");
    }
    let response: Response;
    const requestBody = Buffer.from(serialized);
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: requestBody,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new RedditTransportError(CORE_ERROR_CODES.WORKER_UNAVAILABLE!, "The Reddit worker was unavailable", {
        submissionMayHaveStarted,
        retryable: !submissionMayHaveStarted,
      });
    } finally {
      requestBody.fill(0);
    }
    let bytes: Buffer;
    try {
      bytes = await boundedResponseBody(response, 1024 * 1024);
    } catch {
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit worker response exceeded its byte bound", {
        submissionMayHaveStarted,
      });
    }
    if (response.status !== 200 || bytes.length < 1 || bytes.length > 1024 * 1024) {
      bytes.fill(0);
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit worker returned an invalid response", {
        submissionMayHaveStarted,
      });
    }
    try {
      const envelope = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      assertExactKeys(envelope, ["version", "messageBase64", "platformResult", "failure"]);
      if (envelope.version !== 1 || typeof envelope.messageBase64 !== "string" || !/^[A-Za-z0-9_-]+$/u.test(envelope.messageBase64)) {
        throw new TypeError("invalid worker response envelope");
      }
      const message = Buffer.from(envelope.messageBase64, "base64url");
      if (message.toString("base64url") !== envelope.messageBase64) throw new TypeError("non-canonical worker message");
      const decoded = decodeWorkerMessage(message);
      if (decoded.type !== "social-git.worker.result") throw new TypeError("worker response is not a result");
      if (envelope.failure !== undefined) {
        if (envelope.platformResult !== undefined || decoded.status === "SUCCEEDED") {
          throw new TypeError("worker failure conflicts with the result status");
        }
        const failure = record(envelope.failure, "worker failure");
        assertExactKeys(failure, ["name", "code", "message", "retryable", "actionRequired", "submissionMayHaveStarted"]);
        if (
          typeof failure.code !== "string" || !Object.values(CORE_ERROR_CODES).includes(failure.code) ||
          typeof failure.message !== "string" || failure.message.length < 1 || failure.message.length > 512 ||
          typeof failure.retryable !== "boolean" || typeof failure.actionRequired !== "boolean" ||
          typeof failure.submissionMayHaveStarted !== "boolean"
        ) throw new TypeError("invalid worker failure");
        return {
          message,
          error: new RedditTransportError(failure.code, failure.message, {
            retryable: failure.retryable,
            actionRequired: failure.actionRequired,
            submissionMayHaveStarted: failure.submissionMayHaveStarted || decoded.status === "UNKNOWN",
          }),
        };
      }
      if (decoded.status !== "SUCCEEDED" || envelope.platformResult === undefined) throw new TypeError("worker success result is missing");
      return { message, platformResult: validateRemotePlatformResult(envelope.platformResult) };
    } catch (error) {
      if (error instanceof RedditTransportError) throw error;
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit worker response failed validation", {
        submissionMayHaveStarted,
      });
    } finally {
      bytes.fill(0);
    }
  }

  async dispatch(serialized: Uint8Array): Promise<Uint8Array> {
    return (await this.execute(serialized)).message;
  }
}

async function uploadRedditMedia(input: {
  binding: { tenantId: string; accountId: string; routeId: string; generation: number };
  uploadUrl: string;
  fields: readonly Readonly<{ name: string; value: string }>[];
  filename: string;
  mimeType: string;
  data: Uint8Array;
  resolver: typeof resolvePublicAddresses;
  deadlineEpochMs: number;
}) {
  const boundary = `social-git-${randomUUID().replaceAll("-", "")}`;
  const body = multipartBody(boundary, input.fields, input.filename, input.mimeType, input.data);
  const connector = createPinnedHttpsConnector({ headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
  const authority = createRedditMediaUploadAuthority({
    route: input.binding,
    connector,
    resolver: input.resolver,
    maxResponseBytes: 64 * 1024,
  });
  const lease = authority.issueLease(input.binding);
  const target = new URL(input.uploadUrl);
  try {
    const response = await authority.request(lease, {
      method: "POST",
      path: `${target.pathname}${target.search}`,
      body,
      deadlineEpochMs: input.deadlineEpochMs,
    });
    if (response.status < 200 || response.status > 299) {
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The admitted Reddit media upload was rejected");
    }
  } finally {
    body.fill(0);
  }
}

async function processRedditMedia(input: {
  websocketUrl: string;
  resolver: typeof resolvePublicAddresses;
  deadlineEpochMs: number;
}): Promise<RedditProductionResult> {
  const bytes = await receiveRedditMediaProcessMessage({
    url: input.websocketUrl,
    resolver: input.resolver,
    deadlineEpochMs: input.deadlineEpochMs,
  });
  try {
    const update = record(JSON.parse(Buffer.from(bytes).toString("utf8")), "Reddit media process message");
    assertExactKeys(update, ["type", "payload"]);
    if (update.type === "failed") {
      throw new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "Reddit reported media processing failure", {
        submissionMayHaveStarted: true,
      });
    }
    if (update.type !== "success") throw new TypeError("unknown Reddit media process status");
    const payload = record(update.payload, "Reddit media process payload");
    assertExactKeys(payload, ["redirect"]);
    const canonicalUrl = redditMediaCanonicalUrl(payload.redirect);
    const match = /^\/r\/[^/]+\/comments\/([a-z0-9]+)(?:\/|$)/u.exec(new URL(canonicalUrl).pathname);
    if (!match) throw new TypeError("Reddit media redirect has no post ID");
    return {
      native: { nativeId: `t3_${match[1]}`, canonicalUrl },
      data: { created: true, kind: "media_post" },
    };
  } catch (error) {
    throw submissionError(error);
  } finally {
    bytes.fill(0);
  }
}

function multipartBody(
  boundary: string,
  fields: readonly Readonly<{ name: string; value: string }>[],
  filename: string,
  mimeType: string,
  data: Uint8Array,
) {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      "utf8",
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    "utf8",
  ));
  chunks.push(Buffer.from(data));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (total > 9 * 1024 * 1024) {
    for (const chunk of chunks) chunk.fill(0);
    throw new RedditTransportError(CORE_ERROR_CODES.INVALID_REQUEST!, "The Reddit media multipart body exceeds its bound");
  }
  const result = Buffer.concat(chunks, total);
  for (const chunk of chunks) chunk.fill(0);
  return result;
}

function mediaMetadata(value: Record<string, unknown>): MediaMetadata {
  const filename = boundedString(value.filename, "media filename", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(filename)) throw new TypeError("invalid media filename");
  const mimeType = boundedString(value.mimeType, "media MIME type", 64);
  if (!new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]).has(mimeType)) throw new TypeError("invalid media MIME type");
  if (!Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 1 || Number(value.sizeBytes) > 8 * 1024 * 1024) {
    throw new TypeError("invalid media byte size");
  }
  const sha256 = boundedString(value.sha256, "media SHA-256", 64);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError("invalid media SHA-256");
  return { filename, mimeType: mimeType as MediaMetadata["mimeType"], sizeBytes: Number(value.sizeBytes), sha256 };
}

function mediaBytes(value: Record<string, unknown>, expected: MediaMetadata) {
  const encoded = boundedString(value.dataBase64, "Core media bytes", 11_184_812);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new TypeError("invalid media base64");
  const data = Buffer.from(encoded, "base64");
  if (data.length !== expected.sizeBytes || data.toString("base64") !== encoded
    || createHash("sha256").update(data).digest("hex") !== expected.sha256) {
    data.fill(0);
    throw new TypeError("Core media integrity check failed");
  }
  return data;
}

function mediaPhaseResult(ticket: string, rateLimit?: Readonly<Record<string, number | string>>): RedditProductionResult {
  return { native: null, data: { ticket }, ...(rateLimit ? { rateLimit } : {}) };
}

function mediaTicketError(message: string) {
  return new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, message, { actionRequired: true });
}

function submissionError(error: unknown) {
  if (error instanceof RedditTransportError) {
    return new RedditTransportError(error.code, error.message, {
      retryable: false,
      actionRequired: error.actionRequired,
      submissionMayHaveStarted: true,
      rateLimit: error.rateLimit,
    });
  }
  return new RedditTransportError(CORE_ERROR_CODES.PROTOCOL_DRIFT!, "The Reddit media result is unverified", {
    actionRequired: true,
    submissionMayHaveStarted: true,
  });
}

function redditMediaCanonicalUrl(value: unknown) {
  const raw = boundedString(value, "Reddit media redirect", 2048);
  const url = new URL(raw, "https://www.reddit.com");
  if (url.origin !== "https://www.reddit.com" || url.username || url.password || url.hash) throw new TypeError("invalid Reddit media redirect");
  return url.href;
}

async function boundedResponseBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maximum) throw new RangeError("worker response exceeds its byte bound");
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export class CoreRedditTransportProvider implements RedditTransportProvider {
  private readonly runtime: SessionRuntime;
  private readonly source: OneTimeSessionSource;
  private readonly dispatcher: RedditCommandDispatcher;

  constructor(options: { runtime: SessionRuntime; source: OneTimeSessionSource; dispatcher?: RedditCommandDispatcher }) {
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

  nextConnectionGeneration(account: AccountRecord): number {
    try {
      const state = this.runtime.getAccountState(account.id);
      return Math.max(state.generation, state.revokedThroughGeneration) + 1;
    } catch (error) {
      if ((error as { code?: string })?.code === "NOT_FOUND") return 1;
      throw error;
    }
  }

  importDirectConnection(input: {
    account: AccountRecord;
    generation: number;
    session: Uint8Array;
    networkRoute: { id: string; material: Uint8Array };
  }): void {
    this.runtime.importExternalSession({
      accountId: input.account.id,
      platform: input.account.platform,
      expectedNativeIdentity: input.account.expectedNativeUserId,
      generation: input.generation,
      session: input.session,
      networkRoute: input.networkRoute,
    });
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

function validateRemotePlatformResult(value: unknown): RedditProductionResult {
  const result = record(value, "worker platform result");
  assertExactKeys(result, ["native", "data", "rateLimit"]);
  const data = record(result.data, "worker result data");
  if (JSON.stringify(data).length > 768 * 1024) throw new TypeError("worker result data exceeds its bound");
  let native: RedditProductionResult["native"] = null;
  if (result.native !== null) {
    const reference = record(result.native, "worker native reference");
    assertExactKeys(reference, ["nativeId", "canonicalUrl"]);
    if (typeof reference.nativeId !== "string" || reference.nativeId.length > 128) throw new TypeError("invalid worker native ID");
    if (reference.canonicalUrl !== undefined && (typeof reference.canonicalUrl !== "string" || reference.canonicalUrl.length > 2048)) {
      throw new TypeError("invalid worker canonical URL");
    }
    native = { nativeId: reference.nativeId, ...(reference.canonicalUrl ? { canonicalUrl: reference.canonicalUrl } : {}) };
  }
  let rateLimit: Readonly<Record<string, number | string>> | undefined;
  if (result.rateLimit !== undefined) {
    const rate = record(result.rateLimit, "worker rate limit");
    if (Object.keys(rate).length > 16 || Object.values(rate).some((item) => !["string", "number"].includes(typeof item))) {
      throw new TypeError("invalid worker rate limit");
    }
    rateLimit = rate as Record<string, number | string>;
  }
  return { native, data, ...(rateLimit ? { rateLimit } : {}) };
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new TypeError(`unexpected worker response field: ${unexpected[0]}`);
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
      return { subreddit: payload.subreddit, title: payload.title, media: payload.media };
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
  // Every dispatched operation verifies the immutable identity first. A write's
  // native result identifies the created item, not the authenticated account.
  void result;
  return expected;
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
