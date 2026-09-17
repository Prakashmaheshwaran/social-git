/*
 * Pure, bounded port of unclecode/twikit x_client_transaction at revision
 * 6a73ab97f4de09f79139f6308c9fb80029a9f5f7. Input is parsed as inert text.
 * No JavaScript is evaluated and no browser or executable asset is used.
 */
import { createHash } from "node:crypto";
import { XContractError } from "./contract.mjs";

const EPOCH_SECONDS = 1_682_924_400;
const KEYWORD = "obfiowerehiring";

export function discoverXTransactionAsset(homeHtml) {
  const html = boundedText(homeHtml, "X home HTML", 256 * 1024);
  const chunk = /,(\d{1,8}):["']ondemand\.s["']/u.exec(html);
  if (!chunk) drift("The X ondemand chunk index is missing.");
  const hash = new RegExp(`,${chunk[1]}:["']([0-9a-f]{6,128})["']`, "u").exec(html);
  if (!hash) drift("The X ondemand chunk hash is missing.");
  return Object.freeze({ target: "asset", path: `/responsive-web/client-web/ondemand.s.${hash[1]}a.js` });
}

export function buildXTransactionState(homeHtml, ondemandAssetText) {
  const html = boundedText(homeHtml, "X home HTML", 256 * 1024);
  discoverXTransactionAsset(html);
  const asset = boundedText(ondemandAssetText, "X ondemand asset", 1024 * 1024);
  const meta = /<meta\b(?=[^>]*\bname=["']twitter-site-verification["'])(?=[^>]*\bcontent=["']([^"']+)["'])[^>]*>/iu.exec(html)
    ?? /<meta\b(?=[^>]*\bcontent=["']([^"']+)["'])(?=[^>]*\bname=["']twitter-site-verification["'])[^>]*>/iu.exec(html);
  if (!meta) drift("The X verification key is missing.");
  const keyBytes = canonicalBase64(meta[1]);
  if (keyBytes.length < 16 || keyBytes.length > 256) drift("The X verification key length is invalid.");
  const indices = [...asset.matchAll(/\(\w{1}\[(\d{1,2})\],\s*16\)/gu)].map((match) => Number(match[1]));
  if (indices.length < 2 || indices.length > 16 || indices.some((index) => index >= keyBytes.length)) drift("The X key-byte indices are invalid.");
  const frames = [...html.matchAll(/<[^>]+\bid=["']loading-x-anim-([0-3])["'][^>]*>[\s\S]{0,16384}?<path\b[^>]*\bd=["']([^"']+)["'][^>]*>/giu)];
  if (frames.length !== 4 || new Set(frames.map((match) => match[1])).size !== 4) drift("The X animation frames are invalid.");
  const selected = frames.find((match) => Number(match[1]) === keyBytes[5] % 4);
  if (!selected) drift("The X animation frame selection failed.");
  const rows = selected[2].slice(9).split("C").map((row) => {
    const numbers = row.match(/\d+/gu)?.map(Number) ?? [];
    if (numbers.length < 11 || numbers.length > 32 || numbers.some((value) => value > 65535)) drift("The X animation row is invalid.");
    return numbers;
  });
  const row = rows[keyBytes[indices[0]] % 16];
  if (!row) drift("The X animation row index is out of range.");
  const frameTime = indices.slice(1).reduce((total, index) => total * (keyBytes[index] % 16), 1);
  const animationKey = animate(row, frameTime / 4096);
  return Object.freeze({
    schema: "social-git.x-client-transaction/v1",
    keyBase64: meta[1],
    animationKey,
    rowIndex: indices[0],
    keyByteIndices: Object.freeze(indices.slice(1)),
  });
}

export function generateXClientTransactionId(state, { method, path, nowSeconds, randomByte }) {
  if (!state || state.schema !== "social-git.x-client-transaction/v1") drift("The X transaction state is invalid.");
  if (!new Set(["GET", "POST"]).has(method) || typeof path !== "string" || !path.startsWith("/") || path.length > 2048 || /[\r\n\0]/u.test(path)) drift("The X transaction request is invalid.");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < EPOCH_SECONDS || nowSeconds > 0xffff_ffff + EPOCH_SECONDS) drift("The X transaction timestamp is invalid.");
  if (!Number.isSafeInteger(randomByte) || randomByte < 0 || randomByte > 255) drift("The X transaction random byte is invalid.");
  const keyBytes = canonicalBase64(state.keyBase64);
  const relative = nowSeconds - EPOCH_SECONDS;
  const timeBytes = [0, 1, 2, 3].map((index) => (relative >> (index * 8)) & 0xff);
  const digest = createHash("sha256").update(`${method}!${path}!${relative}${KEYWORD}${state.animationKey}`, "utf8").digest();
  const payload = [...keyBytes, ...timeBytes, ...digest.subarray(0, 16), 3];
  const output = Buffer.from([randomByte, ...payload.map((value) => value ^ randomByte)]).toString("base64").replace(/=+$/u, "");
  digest.fill(0);
  return output;
}

function animate(frame, targetTime) {
  const fromColor = [...frame.slice(0, 3).map(Number), 1];
  const toColor = [...frame.slice(3, 6).map(Number), 1];
  const toRotation = solve(frame[6], 60, 360, true);
  const curves = frame.slice(7, 11).map((value, index) => solve(value, index % 2 ? -1 : 0, 1, false));
  const value = cubic(curves, targetTime);
  const color = interpolate(fromColor, toColor, value).map((item) => item > 0 ? item : 0);
  const rotation = interpolate([0], [toRotation], value)[0];
  const radians = rotation * Math.PI / 180;
  const matrix = [Math.cos(radians), -Math.sin(radians), Math.sin(radians), Math.cos(radians)];
  const fields = color.slice(0, -1).map((item) => bankersRound(item).toString(16));
  for (const item of matrix) {
    const rounded = Math.abs(Math.round(item * 100) / 100);
    const hex = floatToHex(rounded).toLowerCase();
    fields.push(hex.startsWith(".") ? `0${hex}` : (hex || "0"));
  }
  fields.push("0", "0");
  return fields.join("").replace(/[.-]/gu, "");
}

function solve(value, minimum, maximum, rounding) { const result = Number(value) * (maximum - minimum) / 255 + minimum; return rounding ? Math.floor(result) : Math.round(result * 100) / 100; }
function interpolate(from, to, factor) { if (from.length !== to.length) drift("The X animation interpolation is invalid."); return from.map((value, index) => value * (1 - factor) + to[index] * factor); }
function cubic(curves, time) {
  if (curves.length !== 4 || curves.some((value) => !Number.isFinite(value))) drift("The X animation curve is invalid.");
  if (time <= 0) return (curves[0] > 0 ? curves[1] / curves[0] : curves[1] === 0 && curves[2] > 0 ? curves[3] / curves[2] : 0) * time;
  if (time >= 1) { const gradient = curves[2] < 1 ? (curves[3] - 1) / (curves[2] - 1) : curves[2] === 1 && curves[0] < 1 ? (curves[1] - 1) / (curves[0] - 1) : 0; return 1 + gradient * (time - 1); }
  let start = 0; let end = 1; let middle = 0;
  for (let iteration = 0; iteration < 128; iteration += 1) { middle = (start + end) / 2; const estimate = bezier(curves[0], curves[2], middle); if (Math.abs(time - estimate) < 0.00001) return bezier(curves[1], curves[3], middle); if (estimate < time) start = middle; else end = middle; }
  return bezier(curves[1], curves[3], middle);
}
function bezier(a, b, m) { return 3 * a * (1 - m) ** 2 * m + 3 * b * (1 - m) * m ** 2 + m ** 3; }
function bankersRound(value) { const floor = Math.floor(value); const fraction = value - floor; if (Math.abs(fraction - 0.5) < Number.EPSILON * 4) return floor % 2 === 0 ? floor : floor + 1; return Math.round(value); }
function floatToHex(value) { if (!Number.isFinite(value) || value < 0) drift("The X animation matrix is invalid."); let quotient = Math.trunc(value); let fraction = value - quotient; const result = []; while (quotient > 0) { const next = Math.trunc(quotient / 16); const remainder = quotient - next * 16; result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder)); quotient = next; } if (fraction === 0) return result.join(""); result.push("."); for (let index = 0; fraction > 0 && index < 16; index += 1) { fraction *= 16; const integer = Math.trunc(fraction); fraction -= integer; result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer)); } return result.join(""); }
function canonicalBase64(value) { if (typeof value !== "string" || value.length < 1 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) drift("The X verification key encoding is invalid."); const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) { bytes.fill(0); drift("The X verification key is not canonical base64."); } return bytes; }
function boundedText(value, label, maximum) { if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum || value.includes("\0")) drift(`${label} is invalid.`); return value; }
function drift(message) { throw new XContractError("PROTOCOL_DRIFT", message); }
