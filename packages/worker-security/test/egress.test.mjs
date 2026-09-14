import assert from "node:assert/strict";
import test from "node:test";
import {
  SECURITY_ERROR_CODES,
  REDDIT_TARGET_POLICY,
  ServerRouteAuthority,
  assertPublicAddress,
  createRedditRouteAuthority,
  validateDestinationUrl
} from "../src/index.mjs";

test("only a server-issued, exactly bound route lease reaches its assigned connector", async () => {
  const calls = [];
  const authority = makeAuthority({
    connector: async (request) => {
      calls.push(request);
      return ok();
    }
  });
  const lease = authority.issueLease(binding());

  const response = await authority.request(lease, request("/api/me.json"));
  assert.equal(response.status, 200);
  assert.equal(response.finalUrl, "https://www.reddit.com/api/me.json");
  assert.equal("proxyFromEnvironment" in calls[0], false);
  assert.equal(calls[0].redirectMode, "manual");
  assert.equal(calls[0].selectedAddress, "151.101.1.140");
  assert.equal(calls[0].serverName, "www.reddit.com");
  assert.equal(calls[0].signal instanceof AbortSignal, true);

  await assert.rejects(
    authority.request({ ...lease }, request("/api/me.json")),
    hasCode(SECURITY_ERROR_CODES.ROUTE_DENIED)
  );
  assert.throws(
    () => authority.issueLease({ ...binding(), proxyUrl: "http://127.0.0.1:8080" }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  await assert.rejects(
    authority.request(lease, { ...request("/api/me.json"), destination: "https://evil.test" }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  assert.equal(calls.length, 1);
});

test("blocks loopback, private, link-local, metadata, reserved, multicast, and mapped addresses", () => {
  const denied = [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7",
    "203.0.113.7", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1", "100::1", "2001:db8::1", "fc00::1", "fe80::1", "ff02::1"
  ];
  for (const address of denied) {
    assert.throws(() => assertPublicAddress(address), hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED));
  }
  assert.equal(assertPublicAddress("151.101.1.140"), "151.101.1.140");
  assert.equal(assertPublicAddress("2606:4700:4700::1111"), "2606:4700:4700::1111");
});

test("the Reddit authority seals routes to the exact reviewed host set", async () => {
  assert.deepEqual(REDDIT_TARGET_POLICY.admittedHosts, ["www.reddit.com"]);
  assert.throws(
    () => createRedditRouteAuthority({
      routes: [{ id: "route-1", tenantId: "tenant-1", accountId: "account-1", generation: 7, connectorId: "direct", targetId: "evil" }],
      connectors: { direct: async () => ok() },
      resolver: async () => ["151.101.1.140"]
    }),
    hasCode(SECURITY_ERROR_CODES.IPC_SCHEMA)
  );
  const authority = createRedditRouteAuthority({
    routes: [{ id: "route-1", tenantId: "tenant-1", accountId: "account-1", generation: 7, connectorId: "direct" }],
    connectors: { direct: async () => ok() },
    resolver: async () => ["151.101.1.140"]
  });
  await assert.rejects(
    authority.request(authority.issueLease(binding()), request("//old.reddit.com/escape")),
    hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED)
  );
});

test("blocks alternate schemes, userinfo, ports, IP literals, and non-admitted hosts", () => {
  const hosts = ["www.reddit.com", "old.reddit.com"];
  for (const value of [
    "http://www.reddit.com/",
    "ftp://www.reddit.com/",
    "https://user@www.reddit.com/",
    "https://www.reddit.com:8443/",
    "https://127.0.0.1/",
    "https://evil.test/"
  ]) {
    assert.throws(
      () => validateDestinationUrl(new URL(value), hosts),
      hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED)
    );
  }
});

test("re-resolves every redirect and rejects a DNS change to a private address", async () => {
  let resolution = 0;
  let connections = 0;
  const authority = makeAuthority({
    resolver: async () => (++resolution === 1 ? ["151.101.1.140"] : ["127.0.0.1"]),
    connector: async () => {
      connections += 1;
      return {
        status: 302,
        headers: { location: "https://old.reddit.com/next" },
        body: Buffer.alloc(0),
        remoteAddress: "151.101.1.140"
      };
    }
  });

  await assert.rejects(
    authority.request(authority.issueLease(binding()), request("/start")),
    hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED)
  );
  assert.equal(resolution, 2);
  assert.equal(connections, 1);
});

test("rejects redirects to unadmitted authority and connected peers outside the pinned answer", async () => {
  const redirectAuthority = makeAuthority({
    connector: async () => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      body: Buffer.alloc(0),
      remoteAddress: "151.101.1.140"
    })
  });
  await assert.rejects(
    redirectAuthority.request(redirectAuthority.issueLease(binding()), request()),
    hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED)
  );

  const reboundAuthority = makeAuthority({
    connector: async () => ({ ...ok(), remoteAddress: "104.18.1.1" })
  });
  await assert.rejects(
    reboundAuthority.request(reboundAuthority.issueLease(binding()), request()),
    hasCode(SECURITY_ERROR_CODES.DNS_REBINDING)
  );
});

test("does not inherit proxy overrides and enforces redirect and response bounds", async () => {
  const originalProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = "http://127.0.0.1:3128";
  try {
    let redirectCount = 0;
    const authority = makeAuthority({
      maxRedirects: 1,
      connector: async (request) => {
        assert.equal("proxy" in request, false);
        assert.equal("proxyFromEnvironment" in request, false);
        redirectCount += 1;
        return {
          status: 302,
          headers: { location: "/again" },
          body: Buffer.alloc(0),
          remoteAddress: "151.101.1.140"
        };
      }
    });
    await assert.rejects(
      authority.request(authority.issueLease(binding()), request()),
      hasCode(SECURITY_ERROR_CODES.REDIRECT_DENIED)
    );
    assert.equal(redirectCount, 2);

    const oversized = makeAuthority({
      maxResponseBytes: 4,
      connector: async () => ({ ...ok(), body: Buffer.from("12345") })
    });
    await assert.rejects(
      oversized.request(oversized.issueLease(binding()), request()),
      hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
    );
  } finally {
    if (originalProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = originalProxy;
  }
});

test("fails closed when the trusted egress deadline has expired", async () => {
  let connections = 0;
  const authority = makeAuthority({
    now: () => 2_000_000_000_001,
    connector: async () => {
      connections += 1;
      return ok();
    }
  });
  await assert.rejects(
    authority.request(authority.issueLease(binding()), request()),
    hasCode(SECURITY_ERROR_CODES.DESTINATION_DENIED)
  );
  assert.equal(connections, 0);
});

test("aborts hung connectors at the total deadline and bounds streaming bodies before concatenation", async () => {
  let observedSignal;
  const hung = makeAuthority({
    connector: ({ signal }) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
    now: Date.now
  });
  await assert.rejects(
    hung.request(hung.issueLease(binding()), { ...request(), deadlineEpochMs: Date.now() + 20 }),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
  assert.equal(observedSignal.aborted, true);

  const streamed = makeAuthority({
    maxResponseBytes: 4,
    connector: async () => ({
      status: 200,
      headers: {},
      remoteAddress: "151.101.1.140",
      body: (async function* () { yield Buffer.from("123"); yield Buffer.from("45"); })()
    })
  });
  await assert.rejects(
    streamed.request(streamed.issueLease(binding()), request()),
    hasCode(SECURITY_ERROR_CODES.RESPONSE_BOUNDS)
  );
});

function makeAuthority({
  resolver = async () => ["151.101.1.140"],
  connector,
  maxRedirects,
  maxResponseBytes,
  now
}) {
  return new ServerRouteAuthority({
    routes: [{
      id: "route-1",
      tenantId: "tenant-1",
      accountId: "account-1",
      generation: 7,
      targetId: "reddit-web",
      connectorId: "proxy-east"
    }],
    targets: [{
      id: "reddit-web",
      origin: "https://www.reddit.com",
      admittedHosts: ["www.reddit.com", "old.reddit.com"]
    }],
    connectors: { "proxy-east": connector },
    resolver,
    ...(maxRedirects === undefined ? {} : { maxRedirects }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    ...(now === undefined ? {} : { now })
  });
}

function binding() {
  return { tenantId: "tenant-1", accountId: "account-1", routeId: "route-1", generation: 7 };
}

function ok() {
  return { status: 200, headers: {}, body: Buffer.from("{}"), remoteAddress: "151.101.1.140" };
}

function request(path = "/") {
  return { method: "GET", path, body: null, deadlineEpochMs: 2_000_000_000_000 };
}

function hasCode(code) {
  return (error) => error?.code === code;
}
