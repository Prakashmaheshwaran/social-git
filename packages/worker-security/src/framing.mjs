import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

export const FRAME_HEADER_BYTES = 4;

export function encodeLengthPrefixedFrame(payload, maxBytes) {
  if (!(payload instanceof Uint8Array)) {
    fail(SECURITY_ERROR_CODES.IPC_BOUNDS, "The framed payload must be bytes");
  }
  assertFrameBound(payload.byteLength, maxBytes);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class BoundedFrameDecoder {
  #header = Buffer.alloc(FRAME_HEADER_BYTES);
  #headerBytes = 0;
  #payload = null;
  #payloadBytes = 0;
  #maxBytes;
  #onFrame;

  constructor({ maxBytes, onFrame }) {
    assertFrameBound(1, maxBytes);
    if (typeof onFrame !== "function") {
      fail(SECURITY_ERROR_CODES.IPC_BOUNDS, "A frame callback is required");
    }
    this.#maxBytes = maxBytes;
    this.#onFrame = onFrame;
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) {
      fail(SECURITY_ERROR_CODES.IPC_BOUNDS, "The transport chunk must be bytes");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#payload === null) {
        const headerRemaining = FRAME_HEADER_BYTES - this.#headerBytes;
        const copied = Math.min(headerRemaining, chunk.byteLength - offset);
        Buffer.from(chunk.buffer, chunk.byteOffset + offset, copied).copy(this.#header, this.#headerBytes);
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes !== FRAME_HEADER_BYTES) continue;

        const length = this.#header.readUInt32BE(0);
        assertFrameBound(length, this.#maxBytes);
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadBytes = 0;
      }

      const payloadRemaining = this.#payload.byteLength - this.#payloadBytes;
      const copied = Math.min(payloadRemaining, chunk.byteLength - offset);
      Buffer.from(chunk.buffer, chunk.byteOffset + offset, copied).copy(this.#payload, this.#payloadBytes);
      this.#payloadBytes += copied;
      offset += copied;
      if (this.#payloadBytes !== this.#payload.byteLength) continue;

      const complete = this.#payload;
      this.#headerBytes = 0;
      this.#payload = null;
      this.#payloadBytes = 0;
      this.#onFrame(complete);
    }
  }

  end() {
    if (this.#headerBytes !== 0 || this.#payload !== null) {
      fail(SECURITY_ERROR_CODES.IPC_BOUNDS, "The transport ended with a partial frame");
    }
  }
}

export function writeLengthPrefixedFrame(stream, payload, maxBytes) {
  if (!stream || typeof stream.write !== "function" || stream.destroyed) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "The worker byte transport is unavailable");
  }
  const frame = encodeLengthPrefixedFrame(payload, maxBytes);
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => error ? reject(error) : resolve());
  });
}

function assertFrameBound(length, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    fail(SECURITY_ERROR_CODES.IPC_BOUNDS, "The frame byte bound is invalid");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) {
    fail(SECURITY_ERROR_CODES.IPC_BOUNDS, `The declared frame exceeds ${maxBytes} bytes`);
  }
}
