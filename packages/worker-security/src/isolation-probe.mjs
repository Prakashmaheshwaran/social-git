import { readFileSync } from "node:fs";
import { connect } from "node:net";

process.once("message", async (message) => {
  const databaseRead = readAttempt(message.databasePath);
  const keyRead = readAttempt(message.keyPath);
  const loopbackConnect = await connectAttempt("127.0.0.1", 9);
  process.send?.({
    databaseReadable: databaseRead.readable,
    databaseReadErrorCode: databaseRead.errorCode,
    keyReadable: keyRead.readable,
    keyReadErrorCode: keyRead.errorCode,
    filesystemWriteGranted: permissionHas("fs.write"),
    networkGranted: permissionHas("net"),
    networkConnectDeniedByRuntime: loopbackConnect === "ERR_ACCESS_DENIED",
    databaseEnvironmentVisible: environmentMatches(/DATABASE|SQLITE|POSTGRES|MYSQL/iu),
    keyEnvironmentVisible: environmentMatches(/KEY|SECRET|TOKEN|CREDENTIAL/iu),
    controlPlaneEnvironmentVisible: environmentMatches(/PAPERCLIP|CONTROL_PLANE/iu),
    proxyEnvironmentVisible: environmentMatches(/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY/iu)
  });
});

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

function permissionHas(scope) {
  try {
    return process.permission?.has(scope) === true;
  } catch {
    return false;
  }
}

function environmentMatches(pattern) {
  return Object.keys(process.env).some((name) => pattern.test(name));
}
