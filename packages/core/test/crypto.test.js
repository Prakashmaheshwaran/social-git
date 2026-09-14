import assert from "node:assert/strict";
import test from "node:test";
import { SessionEnvelopeCrypto } from "../src/index.js";

const KEY = Buffer.alloc(32, 0x41);
const BINDING = Object.freeze({
  accountId: "account-a",
  platform: "reddit",
  purpose: "session",
  generation: 1
});

function expectCode(code) {
  return (error) => error?.code === code;
}

test("envelopes use fresh nonces and authenticate all binding fields", () => {
  let nonce = 0;
  const crypto = new SessionEnvelopeCrypto({
    masterKey: KEY,
    randomBytes: (size) => Buffer.alloc(size, ++nonce)
  });
  const plaintext = Buffer.from("synthetic-session-cookie");
  const first = crypto.seal(plaintext, BINDING);
  const second = crypto.seal(plaintext, BINDING);

  assert.notEqual(first.toString("utf8"), second.toString("utf8"));
  assert.equal(crypto.open(first, BINDING).toString("utf8"), plaintext.toString("utf8"));

  for (const expected of [
    { ...BINDING, accountId: "account-b" },
    { ...BINDING, platform: "another-platform" },
    { ...BINDING, purpose: "network-route" },
    { ...BINDING, generation: 2 }
  ]) {
    assert.throws(() => crypto.open(first, expected), expectCode("BINDING_MISMATCH"));
  }
  crypto.close();
});

test("tampered and malformed envelopes fail with secret-free errors", () => {
  const crypto = new SessionEnvelopeCrypto({ masterKey: KEY });
  const serialized = crypto.seal(Buffer.from("not-a-real-secret"), BINDING);
  const tampered = JSON.parse(serialized.toString("utf8"));
  const tamperedBytes = Buffer.from(tampered.ciphertext, "base64url");
  tamperedBytes[0] ^= 0x01;
  tampered.ciphertext = tamperedBytes.toString("base64url");
  tamperedBytes.fill(0);

  assert.throws(
    () => crypto.open(Buffer.from(JSON.stringify(tampered)), BINDING),
    (error) => error.code === "CRYPTO_FAILURE"
      && error.cause === undefined
      && !error.message.includes("not-a-real-secret")
  );
  for (const malformed of [
    Buffer.from("not-json"),
    Buffer.from("{}"),
    Buffer.from(JSON.stringify({
      version: 1,
      algorithm: "A256GCM",
      binding: BINDING,
      nonce: "not+base64url",
      ciphertext: "YQ",
      tag: "YQ"
    }))
  ]) {
    assert.throws(() => crypto.open(malformed, BINDING), expectCode("MALFORMED_ENVELOPE"));
  }
  crypto.close();
});
