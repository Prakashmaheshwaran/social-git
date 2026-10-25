import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { assertExactKeys, decodeBoundedJson, encodeBoundedJson } from "./bounds.mjs";
import { BoundedFrameDecoder, encodeLengthPrefixedFrame } from "./framing.mjs";
import { assertEffectiveWorkerPermissions } from "./runtime.mjs";

const maxBytes = 64 * 1024;
const runtime = assertEffectiveWorkerPermissions();
const decoder = new BoundedFrameDecoder({
  maxBytes,
  onFrame(frame) {
    void handle(frame);
  }
});

process.stdin.on("data", (chunk) => decoder.push(chunk));
process.stdin.on("end", () => decoder.end());

async function handle(frame) {
  const message = decodeBoundedJson(frame);
  assertExactKeys(message, ["databasePath", "keyPath"]);
  const databaseRead = readAttempt(message.databasePath);
  const keyRead = readAttempt(message.keyPath);
  const loopbackConnect = await connectAttempt("127.0.0.1", 9);
  const result = {
    databaseReadable: databaseRead.readable,
    databaseReadErrorCode: databaseRead.errorCode,
    keyReadable: keyRead.readable,
    keyReadErrorCode: keyRead.errorCode,
    filesystemWriteGranted: runtime.filesystemWriteGranted,
    networkGranted: runtime.networkGranted,
    networkConnectDeniedByRuntime: loopbackConnect === "ERR_ACCESS_DENIED" || loopbackConnect === "EPERM",
    databaseEnvironmentVisible: environmentMatches(/DATABASE|SQLITE|POSTGRES|MYSQL/iu),
    keyEnvironmentVisible: environmentMatches(/KEY|SECRET|TOKEN|CREDENTIAL/iu),
    controlPlaneEnvironmentVisible: environmentMatches(/CONTROL_PLANE/iu),
    proxyEnvironmentVisible: environmentMatches(/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY/iu),
    runtime
  };
  process.stdout.write(encodeLengthPrefixedFrame(encodeBoundedJson(result), maxBytes));
}

function readAttempt(path) {
  try {
    readFileSync(path);
    return { readable: true, errorCode: null };
  } catch (error) {
    return { readable: false, errorCode: error?.code ?? "UNKNOWN" };
  }
}

function connectAttempt(host, port) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = connect({ host, port });
    } catch (error) {
      resolve(error?.code ?? "UNKNOWN");
      return;
    }
    socket.setTimeout(250);
    socket.once("connect", () => {
      socket.destroy();
      resolve("CONNECTED");
    });
    socket.once("error", (error) => resolve(error?.code ?? "UNKNOWN"));
    socket.once("timeout", () => {
      socket.destroy();
      resolve("TIMEOUT");
    });
  });
}

function environmentMatches(pattern) {
  return Object.keys(process.env).some((name) => pattern.test(name));
}
