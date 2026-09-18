import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OwnerAdmissionProofController } from "../src/admission-proof.ts";

test("admission controller requires owner session, exact Origin, same-origin fetch, JSON, and fresh CSRF", async () => {
  let prepared = 0;
  const coordinator = {
    summary() { return { enabled: true }; },
    prepare() { prepared += 1; return { proof: { id: "proof" } }; },
  };
  const controller = new OwnerAdmissionProofController(coordinator as any, (request, csrfRequired) => {
    if (csrfRequired && request.headers["x-csrf-token"] !== "fresh-token") return null;
    return { callerId: "owner-one", scopes: [], role: "owner" } as any;
  });
  const server = createServer((request, response) => { void controller.handle(request, response); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ accountId: "a", proofKind: "identity", targetId: null, parentProofId: null, expiresInSeconds: 60, confirmation: "x" });
  const send = (headers: Record<string, string>) => fetch(`${base}/v1/control-plane/admission/proofs`, { method: "POST", headers, body });
  try {
    assert.equal((await send({ origin: "https://evil.invalid", "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": "fresh-token" })).status, 403);
    assert.equal((await send({ origin: base, "sec-fetch-site": "cross-site", "content-type": "application/json", "x-csrf-token": "fresh-token" })).status, 403);
    assert.equal((await send({ origin: base, "sec-fetch-site": "same-origin", "content-type": "text/plain", "x-csrf-token": "fresh-token" })).status, 415);
    assert.equal((await send({ origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" })).status, 401);
    assert.equal((await send({ origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": "fresh-token", authorization: "Bearer forbidden" })).status, 403);
    assert.equal((await send({ origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-csrf-token": "fresh-token" })).status, 201);
    assert.equal(prepared, 1);
  } finally { server.close(); await once(server, "close"); }
});

test("admission evidence endpoint always delegates with requester ownership", async () => {
  let ownerSeen = "";
  const coordinator = { evidenceFor(owner: { callerId: string }) { ownerSeen = owner.callerId; return { verification: { valid: true } }; } };
  const controller = new OwnerAdmissionProofController(coordinator as any, () => ({ callerId: "owner-two", scopes: [], role: "owner" } as any));
  const server = createServer((request, response) => { void controller.handle(request, response); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as AddressInfo; const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/v1/control-plane/admission/proofs/11111111-1111-4111-8111-111111111111/evidence`, { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(response.status, 200); assert.equal(ownerSeen, "owner-two");
    const crossSite = await fetch(`${base}/v1/control-plane/admission/proofs/11111111-1111-4111-8111-111111111111/evidence`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(crossSite.status, 403);
  } finally { server.close(); await once(server, "close"); }
});
