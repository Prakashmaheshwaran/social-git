import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as secureRandomBytes
} from "node:crypto";
import { runtimeError, requireValue } from "./errors.js";

const ENVELOPE_VERSION = 1;
const ALGORITHM = "A256GCM";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const PURPOSES = new Set(["session", "network-route"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

export function validateEnvelopeBinding(binding) {
  requireValue(isPlainObject(binding));
  requireValue(validateText(binding.accountId, 128));
  requireValue(validateText(binding.platform, 64));
  requireValue(PURPOSES.has(binding.purpose));
  requireValue(Number.isSafeInteger(binding.generation) && binding.generation > 0);
  requireValue(Object.keys(binding).length === 4);
  return Object.freeze({
    accountId: binding.accountId,
    platform: binding.platform,
    purpose: binding.purpose,
    generation: binding.generation
  });
}

function bindingBytes(binding) {
  const valid = validateEnvelopeBinding(binding);
  return Buffer.from(JSON.stringify({
    accountId: valid.accountId,
    platform: valid.platform,
    purpose: valid.purpose,
    generation: valid.generation
  }), "utf8");
}

function sameBinding(left, right) {
  return left.accountId === right.accountId
    && left.platform === right.platform
    && left.purpose === right.purpose
    && left.generation === right.generation;
}

function decodeBase64Url(value, expectedBytes = undefined) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw runtimeError("MALFORMED_ENVELOPE");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value
    || (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)) {
    decoded.fill(0);
    throw runtimeError("MALFORMED_ENVELOPE");
  }
  return decoded;
}

function parseEnvelope(serialized) {
  const bytes = Buffer.isBuffer(serialized)
    ? serialized
    : serialized instanceof Uint8Array
      ? Buffer.from(serialized.buffer, serialized.byteOffset, serialized.byteLength)
      : typeof serialized === "string"
        ? Buffer.from(serialized, "utf8")
        : null;
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw runtimeError("MALFORMED_ENVELOPE");
  }

  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw runtimeError("MALFORMED_ENVELOPE", error);
  }

  if (!isPlainObject(envelope)
    || envelope.version !== ENVELOPE_VERSION
    || envelope.algorithm !== ALGORITHM
    || Object.keys(envelope).length !== 6) {
    throw runtimeError("MALFORMED_ENVELOPE");
  }

  let binding;
  try {
    binding = validateEnvelopeBinding(envelope.binding);
  } catch (error) {
    throw runtimeError("MALFORMED_ENVELOPE", error);
  }

  return {
    binding,
    nonce: decodeBase64Url(envelope.nonce, NONCE_BYTES),
    ciphertext: decodeBase64Url(envelope.ciphertext),
    tag: decodeBase64Url(envelope.tag, TAG_BYTES)
  };
}

export class SessionEnvelopeCrypto {
  #masterKey;
  #randomBytes;

  constructor({ masterKey, randomBytes = secureRandomBytes }) {
    requireValue(masterKey instanceof Uint8Array && masterKey.byteLength === 32);
    requireValue(typeof randomBytes === "function");
    this.#masterKey = Buffer.from(masterKey);
    this.#randomBytes = randomBytes;
  }

  #deriveKey(binding) {
    const aad = bindingBytes(binding);
    const info = Buffer.concat([
      Buffer.from("social-git/envelope-key/v1\0", "utf8"),
      aad
    ]);
    return Buffer.from(hkdfSync("sha256", this.#masterKey, Buffer.alloc(0), info, 32));
  }

  seal(plaintext, binding) {
    requireValue(plaintext instanceof Uint8Array && plaintext.byteLength > 0);
    const validBinding = validateEnvelopeBinding(binding);
    const nonce = Buffer.from(this.#randomBytes(NONCE_BYTES));
    requireValue(nonce.byteLength === NONCE_BYTES);
    const aad = bindingBytes(validBinding);
    const key = this.#deriveKey(validBinding);
    const cleartext = Buffer.from(plaintext);
    let ciphertext;
    let tag;

    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad, { plaintextLength: cleartext.byteLength });
      ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
      tag = cipher.getAuthTag();
      const envelope = {
        version: ENVELOPE_VERSION,
        algorithm: ALGORITHM,
        binding: validBinding,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url")
      };
      return Buffer.from(JSON.stringify(envelope), "utf8");
    } finally {
      cleartext.fill(0);
      key.fill(0);
      aad.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
      tag?.fill(0);
    }
  }

  open(serialized, expectedBinding) {
    const expected = validateEnvelopeBinding(expectedBinding);
    const envelope = parseEnvelope(serialized);
    if (!sameBinding(envelope.binding, expected)) {
      envelope.nonce.fill(0);
      envelope.ciphertext.fill(0);
      envelope.tag.fill(0);
      throw runtimeError("BINDING_MISMATCH");
    }

    const aad = bindingBytes(expected);
    const key = this.#deriveKey(expected);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, {
        authTagLength: TAG_BYTES
      });
      decipher.setAAD(aad, { plaintextLength: envelope.ciphertext.byteLength });
      decipher.setAuthTag(envelope.tag);
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch (error) {
      throw runtimeError("CRYPTO_FAILURE", error);
    } finally {
      aad.fill(0);
      key.fill(0);
      envelope.nonce.fill(0);
      envelope.ciphertext.fill(0);
      envelope.tag.fill(0);
    }
  }

  close() {
    this.#masterKey.fill(0);
  }
}

export const ENCRYPTED_ENVELOPE_VERSION = ENVELOPE_VERSION;
