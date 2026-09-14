import { createHash, randomBytes } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { assertExactKeys, deepFreeze } from "./bounds.mjs";
import { assertPublicAddress } from "./egress.mjs";
import { SECURITY_ERROR_CODES, WorkerSecurityError, fail } from "./errors.mjs";

export const REDDIT_MEDIA_PROCESS_POLICY = deepFreeze({
  origin: "wss://wss.redditmedia.com",
  admittedHost: "wss.redditmedia.com",
  maxMessageBytes: 64 * 1024,
  maxHandshakeBytes: 16 * 1024
});

export async function receiveRedditMediaProcessMessage({
  url,
  resolver,
  deadlineEpochMs,
  connector = createPinnedWebSocketConnector(),
  maxMessageBytes = REDDIT_MEDIA_PROCESS_POLICY.maxMessageBytes,
  now = Date.now
}) {
  const target = validateProcessUrl(url);
  if (typeof resolver !== "function" || typeof connector !== "function" || typeof now !== "function") {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The Reddit media process transport is invalid");
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1 || maxMessageBytes > 1024 * 1024
    || !Number.isSafeInteger(deadlineEpochMs) || deadlineEpochMs <= now() || deadlineEpochMs - now() > 60_000) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The Reddit media process bounds are invalid");
  }
  const controller = new AbortController();
  const remaining = deadlineEpochMs - now();
  let timer;
  try {
    const dnsDeadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new WorkerSecurityError(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The Reddit media process DNS deadline expired");
        controller.abort(error);
        reject(error);
      }, Math.min(remaining, 2_147_483_647));
    });
    const answers = await Promise.race([
      Promise.resolve().then(() => resolver(target.hostname, { signal: controller.signal })),
      dnsDeadline
    ]);
    clearTimeout(timer);
    if (!Array.isArray(answers) || answers.length < 1 || answers.length > 16) {
      fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "DNS returned an invalid Reddit media answer set");
    }
    const selectedAddress = [...new Set(answers.map(assertPublicAddress))].sort()[0];
    const nextRemaining = deadlineEpochMs - now();
    if (nextRemaining <= 0) fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The Reddit media process deadline expired");
    timer = setTimeout(() => controller.abort(), Math.min(nextRemaining, 2_147_483_647));
    const raw = await connector({
      url: target.href,
      selectedAddress,
      serverName: target.hostname,
      deadlineEpochMs,
      signal: controller.signal,
      maxMessageBytes
    });
    assertExactKeys(raw, ["data", "remoteAddress"]);
    const remoteAddress = assertPublicAddress(raw.remoteAddress);
    if (remoteAddress !== selectedAddress) fail(SECURITY_ERROR_CODES.DNS_REBINDING, "The Reddit media process peer was not DNS pinned");
    const data = typeof raw.data === "string" ? Buffer.from(raw.data, "utf8")
      : raw.data instanceof Uint8Array ? Buffer.from(raw.data) : null;
    if (!data || data.length < 1 || data.length > maxMessageBytes) {
      fail(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The Reddit media process message exceeds its bound");
    }
    return data;
  } catch (error) {
    if (error instanceof WorkerSecurityError) throw error;
    fail(
      controller.signal.aborted ? SECURITY_ERROR_CODES.RESPONSE_BOUNDS : SECURITY_ERROR_CODES.DESTINATION_DENIED,
      controller.signal.aborted ? "The Reddit media process deadline expired" : "The Reddit media process connection failed"
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function createPinnedWebSocketConnector() {
  return ({ url, selectedAddress, serverName, signal, maxMessageBytes }) => new Promise((resolve, reject) => {
    const target = validateProcessUrl(url);
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const socket = tlsConnect({
      host: selectedAddress,
      port: 443,
      servername: serverName,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"]
    });
    let settled = false;
    let handshakeComplete = false;
    let buffered = Buffer.alloc(0);
    let messageOpcode = null;
    let messageBytes = 0;
    const messageChunks = [];

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new WorkerSecurityError(SECURITY_ERROR_CODES.RESPONSE_BOUNDS, "The Reddit media WebSocket deadline expired"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    socket.once("error", (error) => finish(error));
    socket.once("secureConnect", () => {
      const path = `${target.pathname}${target.search}`;
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${target.hostname}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk], buffered.length + chunk.length);
      try {
        if (!handshakeComplete) {
          const headerEnd = buffered.indexOf("\r\n\r\n");
          if (headerEnd < 0) {
            if (buffered.length > REDDIT_MEDIA_PROCESS_POLICY.maxHandshakeBytes) throw new Error("oversized WebSocket handshake");
            return;
          }
          if (headerEnd + 4 > REDDIT_MEDIA_PROCESS_POLICY.maxHandshakeBytes) throw new Error("oversized WebSocket handshake");
          validateHandshake(buffered.subarray(0, headerEnd).toString("latin1"), expectedAccept);
          buffered = buffered.subarray(headerEnd + 4);
          handshakeComplete = true;
        }
        while (buffered.length > 0) {
          const parsed = parseFrame(buffered, maxMessageBytes);
          if (!parsed) return;
          buffered = buffered.subarray(parsed.bytesConsumed);
          if (parsed.opcode === 0x8) throw new Error("WebSocket closed before a media result");
          if (parsed.opcode === 0x9) {
            socket.write(clientFrame(0xA, parsed.payload));
            continue;
          }
          if (parsed.opcode === 0xA) continue;
          if (parsed.opcode === 0x1) {
            if (messageOpcode !== null) throw new Error("nested WebSocket message");
            messageOpcode = 0x1;
          } else if (parsed.opcode !== 0x0 || messageOpcode !== 0x1) {
            throw new Error("unsupported WebSocket media frame");
          }
          messageBytes += parsed.payload.length;
          if (messageBytes > maxMessageBytes) throw new Error("oversized WebSocket media message");
          messageChunks.push(parsed.payload);
          if (parsed.fin) {
            const data = Buffer.concat(messageChunks, messageBytes);
            finish(null, { data, remoteAddress: socket.remoteAddress });
            return;
          }
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

function validateProcessUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The Reddit media process URL is invalid"); }
  if (url.protocol !== "wss:" || url.hostname !== REDDIT_MEDIA_PROCESS_POLICY.admittedHost || url.port
    || url.username || url.password || url.hash || !url.pathname.startsWith("/")) {
    fail(SECURITY_ERROR_CODES.DESTINATION_DENIED, "The Reddit media process destination is not admitted");
  }
  return url;
}

function validateHandshake(text, expectedAccept) {
  const lines = text.split("\r\n");
  if (lines.shift() !== "HTTP/1.1 101 Switching Protocols" || lines.length > 100) throw new Error("invalid WebSocket upgrade status");
  const headers = new Map();
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index < 1) throw new Error("invalid WebSocket upgrade header");
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || value.length > 8192 || headers.has(name)) {
      throw new Error("invalid WebSocket upgrade header");
    }
    headers.set(name, value);
  }
  if (headers.get("upgrade")?.toLowerCase() !== "websocket"
    || !headers.get("connection")?.toLowerCase().split(",").map((item) => item.trim()).includes("upgrade")
    || headers.get("sec-websocket-accept") !== expectedAccept) {
    throw new Error("invalid WebSocket upgrade proof");
  }
}

function parseFrame(buffer, maximum) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  if ((buffer[0] & 0x70) !== 0 || (buffer[1] & 0x80) !== 0) throw new Error("invalid WebSocket frame flags");
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const large = buffer.readBigUInt64BE(2);
    if (large > BigInt(maximum) || large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized WebSocket frame");
    length = Number(large);
    offset = 10;
  }
  if ([0x8, 0x9, 0xA].includes(opcode) && (!fin || length > 125)) throw new Error("invalid WebSocket control frame");
  if (length > maximum) throw new Error("oversized WebSocket frame");
  if (buffer.length < offset + length) return null;
  return { fin, opcode, payload: Buffer.from(buffer.subarray(offset, offset + length)), bytesConsumed: offset + length };
}

function clientFrame(opcode, payload) {
  const bytes = Buffer.from(payload);
  if (bytes.length > 125) throw new Error("oversized client control frame");
  const mask = randomBytes(4);
  const output = Buffer.alloc(2 + 4 + bytes.length);
  output[0] = 0x80 | opcode;
  output[1] = 0x80 | bytes.length;
  mask.copy(output, 2);
  for (let index = 0; index < bytes.length; index += 1) output[6 + index] = bytes[index] ^ mask[index % 4];
  return output;
}
