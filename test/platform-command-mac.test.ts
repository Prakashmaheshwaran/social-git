import assert from "node:assert/strict";
import test from "node:test";
import { REDDIT_COMMAND_MAC_CONTEXT, RedditCommandMacSigner, RedditCommandMacVerifier } from "../src/reddit-ipc-auth.ts";
import { X_COMMAND_MAC_CONTEXT, XCommandMacSigner, XCommandMacVerifier } from "../src/x-ipc-auth.ts";

// These literals were produced by the pre-refactor implementation. They pin the
// exact wire format (MAC domain string, header names, MAC input composition) of
// both command-MAC implementations so any refactor must stay byte-identical.
const NOW = 1_800_000_000_000;
const NONCE_TEXT = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
const REDDIT_KEY = Buffer.alloc(32, 0xb6);
const X_KEY = Buffer.alloc(32, 0xb7);
const DISPATCH_BODY = Buffer.from("golden-dispatch-command");
const READY_BODY = Buffer.alloc(0);

const REDDIT_RESPONSE_200 = Buffer.from(`{"version":1,"role":"reddit-worker","status":"ready","inFlight":0,"requestNonce":"${NONCE_TEXT}"}`);
const REDDIT_RESPONSE_401 = Buffer.from('{"version":1,"code":"REDDIT_COMMAND_UNAUTHENTICATED"}');
const REDDIT_RESPONSE_503 = Buffer.from(`{"version":1,"code":"WORKER_STOPPING","requestNonce":"${NONCE_TEXT}"}`);
const X_RESPONSE_200 = Buffer.from(`{"version":1,"role":"x-worker","status":"ready","inFlight":0,"admission":{"requested":true,"enabled":true,"productionEnabled":true,"disabledReasons":[]},"requestNonce":"${NONCE_TEXT}"}`);
const X_RESPONSE_401 = Buffer.from('{"code":"X_COMMAND_UNAUTHENTICATED"}');
const X_RESPONSE_503 = Buffer.from(`{"version":1,"code":"WORKER_STOPPING","requestNonce":"${NONCE_TEXT}"}`);

function fixedNonce() { return Buffer.from(NONCE_TEXT, "base64url"); }

type WireHeaders = Record<string, string | string[] | undefined>;
function wire(headers: { "x-social-git-command-timestamp": string; "x-social-git-command-nonce": string; "x-social-git-command-mac": string }): WireHeaders { return { ...headers }; }

function redditSigner(now = NOW) { return new RedditCommandMacSigner(REDDIT_KEY, { now: () => now, nonce: fixedNonce }); }
function xSigner(now = NOW) { return new XCommandMacSigner(X_KEY, { now: () => now, nonce: fixedNonce }); }

test("Reddit command MAC pins its dispatch, readiness, and response wire vectors", () => {
  const signer = redditSigner();
  try {
    assert.deepEqual(signer.headers(DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "c662dc2d44c0939319cd9852e137e0edcffca90d14566533f0e9299f6545ddbe",
    });
    assert.deepEqual(signer.headers(READY_BODY, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "0735ce36033a676a9b08363e459e412e1324ff4ea45e6495a358f9615e1436bd",
    });
    assert.deepEqual(signer.headers(REDDIT_RESPONSE_200, REDDIT_COMMAND_MAC_CONTEXT.response(200)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "1f51893e982a91a45100613918bd2ae92ec379345947bee36ea5cfb031946ac2",
    });
    assert.deepEqual(signer.headers(REDDIT_RESPONSE_401, REDDIT_COMMAND_MAC_CONTEXT.response(401)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "251b1c5863818a3e004f0b6482e81ebad84451b0afabd30200203a77f08fbed8",
    });
    assert.deepEqual(signer.headers(REDDIT_RESPONSE_503, REDDIT_COMMAND_MAC_CONTEXT.response(503)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "50fdc3a309d730b1536d8f4d0136762da3289376ccff5ad75f1eee5389a927ca",
    });
  } finally { signer.close(); }
});

test("X command MAC pins its dispatch, readiness, and response wire vectors", () => {
  const signer = xSigner();
  try {
    assert.deepEqual(signer.headers(DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "9247f5d4db78758f07320cac254b1466271c8e41e95e75c9944f0e5c648abac4",
    });
    assert.deepEqual(signer.headers(READY_BODY, X_COMMAND_MAC_CONTEXT.readinessRequest), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "8c37eccf55900e8fa0390e1278edf58c72b4744962d3fa7a38a85e3ea82ca73a",
    });
    assert.deepEqual(signer.headers(X_RESPONSE_200, X_COMMAND_MAC_CONTEXT.response(200)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "b2b2d883f3331d63de675eb935dc935e89b0ec15e54b8b240c435e4dfb11721c",
    });
    assert.deepEqual(signer.headers(X_RESPONSE_401, X_COMMAND_MAC_CONTEXT.response(401)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "638673906d3938044b183d23dcaa40303e55bc5320dc88e389e2f475e5a60da3",
    });
    assert.deepEqual(signer.headers(X_RESPONSE_503, X_COMMAND_MAC_CONTEXT.response(503)), {
      "x-social-git-command-timestamp": "1800000000000",
      "x-social-git-command-nonce": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
      "x-social-git-command-mac": "9ad48802983db653d8dcac192743a7b1079fce394fd1c54a81705ee624f71a15",
    });
  } finally { signer.close(); }
});

test("Reddit and X MACs are domain separated for identical inputs", () => {
  const reddit = redditSigner();
  const x = xSigner();
  try {
    const redditHeaders = reddit.headers(DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest);
    const xHeaders = x.headers(DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest);
    assert.notEqual(redditHeaders["x-social-git-command-mac"], xHeaders["x-social-git-command-mac"]);
    assert.equal(new XCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(redditHeaders), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(xHeaders), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
  } finally { reddit.close(); x.close(); }
});

test("Reddit verifier accepts the pinned vectors and rejects replay, skew, and tampering", () => {
  const signer = redditSigner();
  try {
    const dispatch = signer.headers(DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    const readiness = signer.headers(READY_BODY, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(readiness), READY_BODY, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest), true);
    const response = signer.headers(REDDIT_RESPONSE_200, REDDIT_COMMAND_MAC_CONTEXT.response(200));
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(response), REDDIT_RESPONSE_200, REDDIT_COMMAND_MAC_CONTEXT.response(200)), true);

    const replay = new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW });
    assert.equal(replay.verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    assert.equal(replay.verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    replay.close();

    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW - 30_001 }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW + 30_001 }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW - 30_000 }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW + 30_000 }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), true);

    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(dispatch), Buffer.from("golden-dispatch-commanD"), REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify({ ...dispatch, "x-social-git-command-mac": `${dispatch["x-social-git-command-mac"].slice(0, -1)}0` }, DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(Buffer.alloc(32, 0xb7), { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.readinessRequest), false);
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.response(200)), false);
  } finally { signer.close(); }
});

test("X verifier accepts the pinned vectors and rejects replay, skew, and tampering", () => {
  const signer = xSigner();
  try {
    const dispatch = signer.headers(DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    const readiness = signer.headers(READY_BODY, X_COMMAND_MAC_CONTEXT.readinessRequest);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(readiness), READY_BODY, X_COMMAND_MAC_CONTEXT.readinessRequest), true);
    const response = signer.headers(X_RESPONSE_200, X_COMMAND_MAC_CONTEXT.response(200));
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(response), X_RESPONSE_200, X_COMMAND_MAC_CONTEXT.response(200)), true);

    const replay = new XCommandMacVerifier(X_KEY, { now: () => NOW });
    assert.equal(replay.verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    assert.equal(replay.verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    replay.close();

    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW - 30_001 }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW + 30_001 }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW - 30_000 }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), true);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW + 30_000 }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), true);

    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(dispatch), Buffer.from("golden-dispatch-commanD"), X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify({ ...dispatch, "x-social-git-command-mac": `${dispatch["x-social-git-command-mac"].slice(0, -1)}0` }, DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new XCommandMacVerifier(Buffer.alloc(32, 0xb6), { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.dispatchRequest), false);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.readinessRequest), false);
    assert.equal(new XCommandMacVerifier(X_KEY, { now: () => NOW }).verify(wire(dispatch), DISPATCH_BODY, X_COMMAND_MAC_CONTEXT.response(200)), false);
  } finally { signer.close(); }
});

test("command MAC contexts and key checks keep their per-platform error text", () => {
  const reddit = redditSigner();
  const x = xSigner();
  try {
    assert.throws(() => reddit.headers(READY_BODY, "bad\ncontext"), { name: "TypeError", message: "The Reddit command MAC context is invalid" });
    assert.throws(() => x.headers(READY_BODY, "bad\ncontext"), { name: "TypeError", message: "The X command MAC context is invalid" });
    // Reddit validates the context lazily, after the header shape check, so an
    // empty header set short-circuits to false; X validates it eagerly.
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }).verify({}, READY_BODY, "bad\0context"), false);
    assert.throws(() => XCommandMacVerifier.prototype.verify.call(new XCommandMacVerifier(X_KEY, { now: () => NOW }), {}, READY_BODY, "bad\0context"), { name: "TypeError", message: "The X command MAC context is invalid" });
    const redditDispatch = reddit.headers(DISPATCH_BODY, REDDIT_COMMAND_MAC_CONTEXT.dispatchRequest);
    assert.throws(() => RedditCommandMacVerifier.prototype.verify.call(new RedditCommandMacVerifier(REDDIT_KEY, { now: () => NOW }), wire(redditDispatch), DISPATCH_BODY, "bad\0context"), { name: "TypeError", message: "The Reddit command MAC context is invalid" });
    assert.throws(() => REDDIT_COMMAND_MAC_CONTEXT.response(99), { name: "TypeError", message: "The Reddit command response status is invalid" });
    assert.throws(() => X_COMMAND_MAC_CONTEXT.response(600), { name: "TypeError", message: "The X command response status is invalid" });
    assert.throws(() => new RedditCommandMacSigner(Buffer.alloc(31)), { name: "TypeError", message: "A distinct 32-byte Reddit command key is required" });
    assert.throws(() => new XCommandMacSigner(Buffer.alloc(31)), { name: "TypeError", message: "A distinct 32-byte X command key is required" });
    assert.equal(new RedditCommandMacVerifier(REDDIT_KEY).verify({}, READY_BODY, "dispatch"), false);
    assert.equal(new XCommandMacVerifier(X_KEY).verify({}, READY_BODY, "dispatch"), false);
  } finally { reddit.close(); x.close(); }
});
