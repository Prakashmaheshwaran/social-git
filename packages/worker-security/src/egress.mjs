import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { assertExactKeys, deepFreeze } from "./bounds.mjs";
import { SECURITY_ERROR_CODES, WorkerSecurityError, fail } from "./errors.mjs";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_FIELDS = ["method", "path", "body", "deadlineEpochMs"];

export const REDDIT_TARGET_POLICY = deepFreeze({
  id: "reddit-web",
  origin: "https://www.reddit.com",
  admittedHosts: ["www.reddit.com"]
});

export function createRedditRouteAuthority({ routes, connectors, resolver, ...options }) {
  if (!Array.isArray(routes)) {
    fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Reddit routes are required");
  }
  const sealedRoutes = routes.map((route) => {
    assertExactKeys(route, ["id", "tenantId", "accountId", "generation", "connectorId"]);
    return { ...route, targetId: REDDIT_TARGET_POLICY.id };
  });
  return new ServerRouteAuthority({
    ...options,
    routes: sealedRoutes,
    targets: [REDDIT_TARGET_POLICY],
    connectors,
    resolver
  });
}

export class ServerRouteAuthority {
  #routes = new Map();
  #targets = new Map();
  #connectors = new Map();
  #resolver;
  #leases = new WeakMap();
  #maxRedirects;
  #maxResponseBytes;
  #now;

  constructor({
    routes,
    targets,
    connectors,
    resolver,
    maxRedirects = 3,
    maxResponseBytes = 2 * 1024 * 1024,
    now = Date.now
  }) {
    if (!Array.isArray(routes) || !Array.isArray(targets) || typeof resolver !== "function") {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Routes, targets, and a resolver are required");
    }
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Invalid redirect bound");
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Invalid response-byte bound");
    }
    if (typeof now !== "function") {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "A trusted clock is required");
    }
    this.#resolver = resolver;
    this.#maxRedirects = maxRedirects;
    this.#maxResponseBytes = maxResponseBytes;
    this.#now = now;

    for (const [connectorId, connector] of Object.entries(connectors ?? {})) {
      requireId(connectorId, "connectorId");
      if (typeof connector !== "function") {
        fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "A route connector must be a function");
      }
      this.#connectors.set(connectorId, connector);
    }
    for (const target of targets) {
      assertExactKeys(target, ["id", "origin", "admittedHosts"]);
      requireId(target.id, "targetId");
      if (this.#targets.has(target.id)) {
        fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Duplicate target ID");
      }
      const origin = validateDestinationUrl(new URL(target.origin), target.admittedHosts);
      this.#targets.set(target.id, deepFreeze({
        id: target.id,
        origin: origin.origin,
        admittedHosts: normalizeHosts(target.admittedHosts)
      }));
    }
    for (const route of routes) {
      assertExactKeys(route, ["id", "tenantId", "accountId", "generation", "targetId", "connectorId"]);
      for (const field of ["id", "tenantId", "accountId", "targetId", "connectorId"]) {
        requireId(route[field], field);
      }
      if (!Number.isSafeInteger(route.generation) || route.generation < 1) {
        fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Invalid route generation");
      }
      if (this.#routes.has(route.id) || !this.#targets.has(route.targetId) || !this.#connectors.has(route.connectorId)) {
        fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "The route references unknown or duplicate server configuration");
      }
      this.#routes.set(route.id, deepFreeze(structuredClone(route)));
    }
  }

  issueLease(binding) {
    assertExactKeys(binding, ["tenantId", "accountId", "routeId", "generation"]);
    const route = this.#routes.get(binding.routeId);
    if (
      !route ||
      route.tenantId !== binding.tenantId ||
      route.accountId !== binding.accountId ||
      route.generation !== binding.generation
    ) {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "The server-owned route binding does not match");
    }
    const lease = deepFreeze({
      tenantId: route.tenantId,
      accountId: route.accountId,
      routeId: route.id,
      generation: route.generation
    });
    this.#leases.set(lease, route);
    return lease;
  }

  async request(lease, descriptor) {
    const route = this.#leases.get(lease);
    if (!route) {
      fail(SECURITY_ERROR_CODES.ROUTE_DENIED, "Only a server-issued route lease is accepted");
    }
    assertExactKeys(descriptor, REQUEST_FIELDS);
    if (!new Set(["GET", "POST"]).has(descriptor.method)) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The method is not admitted");
    }
    if (typeof descriptor.path !== "string" || !descriptor.path.startsWith("/") || descriptor.path.startsWith("//")) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The path must be origin-relative");
    }
    if (descriptor.path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(descriptor.path)) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The path contains forbidden characters");
    }
    if (!Number.isSafeInteger(descriptor.deadlineEpochMs) || descriptor.deadlineEpochMs <= this.#now()) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The egress deadline is invalid or expired");
    }
    const target = this.#targets.get(route.targetId);
    const connector = this.#connectors.get(route.connectorId);
    let url = validateDestinationUrl(new URL(descriptor.path, target.origin), target.admittedHosts);
    let method = descriptor.method;
    let body = descriptor.body;
    const deadlineController = new AbortController();

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        const addresses = await withinDeadline(
          () => resolvePublic(this.#resolver, url.hostname, deadlineController.signal),
          descriptor.deadlineEpochMs,
          this.#now,
          deadlineController,
          SECURITY_ERROR_CODES.DESTINATION_DENIED,
          "The egress deadline expired during DNS resolution"
        );
        const selectedAddress = addresses[0];
        const raw = await withinDeadline(
          () => connector(Object.freeze({
            method,
            url: url.href,
            body,
            selectedAddress,
            serverName: url.hostname,
            redirectMode: "manual",
            deadlineEpochMs: descriptor.deadlineEpochMs,
            signal: deadlineController.signal
          })),
          descriptor.deadlineEpochMs,
          this.#now,
          deadlineController,
          SECURITY_ERROR_CODES.RESPONSE_BOUNDS,
          "The egress deadline expired during connect or response headers"
        );
        validateConnectorMetadata(raw, selectedAddress);
        const boundedBody = await readBoundedBody(
          raw.body,
          this.#maxResponseBytes,
          descriptor.deadlineEpochMs,
          this.#now,
          deadlineController
        );

        if (!REDIRECT_STATUSES.has(raw.status)) {
          return deepFreeze({
            status: raw.status,
            headers: structuredClone(raw.headers),
            body: boundedBody,
            finalUrl: url.href,
            redirectCount
          });
        }
        if (redirectCount >= this.#maxRedirects) {
          fail(SECURITY_ERROR_CODES.REDIRECT_DENIED, "The redirect limit was reached");
        }
        const location = headerValue(raw.headers, "location");
        if (!location) {
          fail(SECURITY_ERROR_CODES.REDIRECT_DENIED, "A redirect response has no location");
        }
        try {
          url = validateDestinationUrl(new URL(location, url), target.admittedHosts);
        } catch (error) {
          if (error?.code) throw error;
          fail(SECURITY_ERROR_CODES.REDIRECT_DENIED, "The redirect location is invalid");
        }
        if (raw.status === 303) {
          method = "GET";
          body = null;
        }
      }
    } finally {
      deadlineController.abort();
    }
  }
}

export function createPinnedHttpsConnector() {
  return ({ method, url, body, selectedAddress, serverName, signal }) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpsRequest(target, {
      method,
      agent: false,
      signal,
      servername: serverName,
      lookup(_hostname, _options, callback) {
        callback(null, selectedAddress, isIP(selectedAddress));
      },
      headers: body instanceof Uint8Array ? { "content-length": body.byteLength } : undefined
    });
    request.once("response", (response) => resolve({
      status: response.statusCode,
      headers: normalizeNodeHeaders(response.headers),
      body: response,
      remoteAddress: response.socket.remoteAddress
    }));
    request.once("error", reject);
    if (body !== null && body !== undefined) request.write(body);
    request.end();
  });
}

export function validateDestinationUrl(url, admittedHosts) {
  if (!(url instanceof URL) || url.protocol !== "https:") {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "Only HTTPS destinations are admitted");
  }
  if (url.username || url.password || url.hash || (url.port && url.port !== "443") || isIP(url.hostname)) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "Destination authority is not admitted");
  }
  const hosts = normalizeHosts(admittedHosts);
  if (!hosts.includes(url.hostname.toLowerCase())) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "Destination host is not admitted");
  }
  return url;
}

export function assertPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    const denied = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
    ];
    if (denied.some(([network, bits]) => inIpv4Cidr(value, ipv4Number(network), bits))) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, `The resolved IPv4 address is not public: ${address}`);
    }
    return address;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
    if (mapped) {
      return assertPublicAddress(mapped[1]);
    }
    const value = ipv6BigInt(normalized);
    const wellKnownNat64 = ipv6BigInt("64:ff9b::");
    if (inIpv6Cidr(value, wellKnownNat64, 96)) {
      const embedded = Number(value & 0xffffffffn);
      assertPublicAddress([
        (embedded >>> 24) & 255,
        (embedded >>> 16) & 255,
        (embedded >>> 8) & 255,
        embedded & 255
      ].join("."));
      return address;
    }
    const denied = [
      ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48],
      ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28],
      ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
      ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
    ];
    if (denied.some(([network, bits]) => inIpv6Cidr(value, ipv6BigInt(network), bits))) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, `The resolved IPv6 address is not public: ${address}`);
    }
    return address;
  }
  fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "DNS returned a non-IP address");
}

async function resolvePublic(resolver, hostname, signal) {
  let answers;
  try {
    answers = await resolver(hostname, { signal });
  } catch {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "DNS resolution failed closed");
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > 16) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "DNS returned an invalid answer set");
  }
  return deepFreeze([...new Set(answers.map(assertPublicAddress))].sort());
}

function validateConnectorMetadata(raw, selectedAddress) {
  assertExactKeys(raw, ["status", "headers", "body", "remoteAddress"]);
  if (!Number.isSafeInteger(raw.status) || raw.status < 100 || raw.status > 599) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned an invalid status");
  }
  if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers)) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned invalid headers");
  }
  if (Object.getPrototypeOf(raw.headers) !== Object.prototype) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned non-plain headers");
  }
  const headerDescriptors = Object.getOwnPropertyDescriptors(raw.headers);
  const headerNames = Object.keys(headerDescriptors);
  if (headerNames.length > 100) {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned too many headers");
  }
  for (const name of headerNames) {
    const descriptor = headerDescriptors[name];
    if (!("value" in descriptor) || descriptor.get || descriptor.set) {
      fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned an accessor header");
    }
    const values = Array.isArray(descriptor.value) ? descriptor.value : [descriptor.value];
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
      values.length > 16 ||
      values.some((value) => typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8 * 1024)
    ) {
      fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned an invalid header");
    }
  }
  assertPublicAddress(raw.remoteAddress);
  if (raw.remoteAddress !== selectedAddress) {
    fail(SECURITY_ERROR_CODES.DNS_REBINDING, "The connected peer was not in the pinned DNS answer set");
  }
}

async function readBoundedBody(body, maxBytes, deadlineEpochMs, now, controller) {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport response exceeds its byte bound");
    return Buffer.from(body);
  }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport body must be bytes or a byte stream");
  }
  const chunks = [];
  let total = 0;
  const iterator = body[Symbol.asyncIterator]();
  try {
    while (true) {
      const item = await withinDeadline(
        () => iterator.next(), deadlineEpochMs, now, controller,
        SECURITY_ERROR_CODES.RESPONSE_BOUNDS,
        "The egress deadline expired while reading the response body"
      );
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport returned a non-byte body chunk");
      total += item.value.byteLength;
      if (total > maxBytes) fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The transport response exceeds its byte bound");
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    if (controller.signal.aborted && typeof iterator.return === "function") await iterator.return().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

async function withinDeadline(start, deadlineEpochMs, now, controller, code, message) {
  const remaining = deadlineEpochMs - now();
  if (remaining <= 0) {
    controller.abort();
    throw new WorkerSecurityError(code, message);
  }
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(start),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new WorkerSecurityError(code, message);
          controller.abort(error);
          reject(error);
        }, Math.min(remaining, 2_147_483_647));
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNodeHeaders(headers) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return result;
}

function headerValue(headers, targetName) {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === targetName) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function normalizeHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 16) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "An admitted host list is required");
  }
  return [...new Set(hosts.map((host) => {
    if (typeof host !== "string" || host !== host.toLowerCase() || !/^[a-z0-9.-]+$/u.test(host) || isIP(host)) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "Invalid admitted host");
    }
    return host;
  }))];
}

function requireId(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(SECURITY_ERROR_CODES.ROUTE_DENIED, `Invalid ${field}`);
  }
}

function ipv4Number(address) {
  const octets = address.split(".").map(Number);
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Cidr(value, network, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6BigInt(address) {
  const [headText, tailText = ""] = address.split("::");
  const head = headText ? headText.split(":") : [];
  const tail = tailText ? tailText.split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "DNS returned an invalid IPv6 address");
  }
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Cidr(value, network, bits) {
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (network >> shift);
}
