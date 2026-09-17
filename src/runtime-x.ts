import { randomInt } from "node:crypto";
import {
  XContractError,
  X_MAX_HOME_HTML_BYTES,
  XSessionTransport,
  buildXTransactionState,
  createXSessionConnector,
  discoverXTransactionAsset,
  generateXClientTransactionId,
} from "@social-git/x-adapter";
import { createXRouteAuthority } from "@social-git/worker-security";

export interface XCandidateBinding {
  tenantId: string;
  accountId: string;
  routeId: string;
  generation: number;
}

export interface XWireRequest {
  method: "GET" | "POST";
  url: string;
  body: Uint8Array | null;
  headers: Readonly<Record<string, string>>;
  selectedAddress: string;
  serverName: string;
  redirectMode: "manual";
  deadlineEpochMs: number;
  signal: AbortSignal;
}

/**
 * Build the isolated candidate transport from already-decrypted Core command
 * material. The caller owns and zeroes sessionBytes. No default resolver or
 * connector is provided, preventing this helper from making an accidental
 * live call outside the admitted worker composition.
 */
export async function bootstrapXCandidateTransport(input: {
  binding: XCandidateBinding;
  expectedNativeIdentity: string;
  sessionBytes: Uint8Array;
  routeBytes: Uint8Array;
  resolver: (hostname: string, options: { signal: AbortSignal }) => Promise<string[]>;
  wireConnector: (request: Readonly<Record<string, any>>) => Promise<Record<string, any>>;
  now?: () => number;
  randomByte?: () => number;
}) {
  const now = input.now ?? Date.now;
  const randomByte = input.randomByte ?? (() => randomInt(0, 256));
  const session = parseXSession(input.sessionBytes);
  const route = parseDirectRoute(input.routeBytes);
  void route;
  const bootstrapConnector = createXSessionConnector({ ...session, wireConnector: input.wireConnector });
  const bootstrapAuthority = createXRouteAuthority({
    route: input.binding,
    connectors: { web: bootstrapConnector, api: bootstrapConnector, upload: bootstrapConnector, asset: bootstrapConnector },
    resolver: input.resolver,
    maxResponseBytes: 1024 * 1024,
    now,
  });
  const bootstrapLease = bootstrapAuthority.issueLease(input.binding);
  const home = await bootstrapAuthority.request(bootstrapLease, { target: "web", method: "GET", path: "/home", body: null, deadlineEpochMs: now() + 10_000 });
  const homeHtml = decodeText(home.body, X_MAX_HOME_HTML_BYTES, "X home HTML");
  const assetDescriptor = discoverXTransactionAsset(homeHtml);
  const asset = await bootstrapAuthority.request(bootstrapLease, { target: "asset", method: "GET", path: assetDescriptor.path, body: null, deadlineEpochMs: now() + 10_000 });
  const assetText = decodeText(asset.body, 1024 * 1024, "X ondemand asset");
  let state: ReturnType<typeof buildXTransactionState>;
  try { state = buildXTransactionState(homeHtml, assetText); }
  finally { /* immutable strings are scoped to this worker call and never returned */ }

  const connector = createXSessionConnector({
    ...session,
    transactionIdFor(method: string, path: string) {
      return generateXClientTransactionId(state, {
        method,
        path,
        nowSeconds: Math.floor(now() / 1000),
        randomByte: randomByte(),
      });
    },
    wireConnector: input.wireConnector,
  });
  const authority = createXRouteAuthority({
    route: input.binding,
    connectors: { web: connector, api: connector, upload: connector, asset: connector },
    resolver: input.resolver,
    maxResponseBytes: 1024 * 1024,
    now,
  });
  return new XSessionTransport({
    routeAuthority: authority,
    binding: input.binding,
    expectedNativeIdentity: input.expectedNativeIdentity,
    now,
  });
}

function parseXSession(bytes: Uint8Array) {
  const value = parseJson(bytes, 48 * 1024, "X session material");
  exact(value, ["cookies"]);
  const cookies = record(value.cookies, "X cookies");
  exact(cookies, ["auth_token", "ct0"]);
  return { authToken: secret(cookies.auth_token, "auth_token"), csrfToken: secret(cookies.ct0, "ct0") };
}

function parseDirectRoute(bytes: Uint8Array) {
  const value = parseJson(bytes, 16 * 1024, "X route material");
  exact(value, ["kind"]);
  if (value.kind !== "direct") throw new XContractError("PROTOCOL_DRIFT", "The configured X route is not admitted.");
  return value;
}

function parseJson(bytes: Uint8Array, maximum: number, label: string) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) throw new XContractError("INVALID_REQUEST", `${label} is invalid.`);
  try { return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), label); }
  catch (error) { if (error instanceof XContractError) throw error; throw new XContractError("INVALID_REQUEST", `${label} is invalid.`); }
}
function decodeText(bytes: Uint8Array, maximum: number, label: string) { if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) throw new XContractError("PROTOCOL_DRIFT", `${label} is invalid.`); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new XContractError("PROTOCOL_DRIFT", `${label} is invalid.`); } }
function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new XContractError("INVALID_REQUEST", `${label} must be a plain object.`); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw new XContractError("INVALID_REQUEST", "The X secret envelope has unexpected fields."); }
function secret(value: unknown, label: string) { if (typeof value !== "string" || value.length < 1 || value.length > 8192 || /[;\r\n\0]/u.test(value)) throw new XContractError("INVALID_REQUEST", `The X ${label} is invalid.`); return value; }
