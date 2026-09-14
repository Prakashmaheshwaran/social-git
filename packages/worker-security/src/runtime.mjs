import { fork } from "node:child_process";
import { resolve } from "node:path";
import { assertExactKeys, deepFreeze } from "./bounds.mjs";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

const FORBIDDEN_ENVIRONMENT = /(?:^|_)(?:http_proxy|https_proxy|all_proxy|no_proxy|database|sqlite|postgres|mysql|redis|key|secret|token|credential|paperclip|control_plane)(?:_|$)/iu;

export const WORKER_SANDBOX_POLICY = deepFreeze({
  distinctUid: 65532,
  distinctGid: 65532,
  rootFilesystem: "read_only",
  writablePaths: [],
  capabilities: [],
  noNewPrivileges: true,
  network: "none",
  resources: {
    pids: 1,
    nofile: 64,
    memoryBytes: 134_217_728,
    cpuQuotaMicros: 50_000,
    cpuPeriodMicros: 100_000
  },
  databaseMounts: [],
  keyMounts: [],
  controlPlaneSockets: [],
  connector: "trusted_core_egress_broker_only"
});

export function createIsolatedForkOptions({ readPaths, environment = {} }) {
  if (!Array.isArray(readPaths) || readPaths.length < 1 || readPaths.length > 32) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "One or more worker code read paths are required");
  }
  assertExactKeys({ environment }, ["environment"]);
  const cleanEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) || FORBIDDEN_ENVIRONMENT.test(name)) {
      fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, `Forbidden worker environment variable: ${name}`);
    }
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
      fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, `Invalid worker environment value: ${name}`);
    }
    cleanEnvironment[name] = value;
  }
  const normalizedPaths = [...new Set(readPaths.map((path) => {
    if (typeof path !== "string" || path.length === 0) {
      fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "Invalid worker read path");
    }
    return resolve(path);
  }))];
  return {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
    env: cleanEnvironment,
    execArgv: ["--permission", ...normalizedPaths.map((path) => `--allow-fs-read=${path}`)]
  };
}

export function forkIsolatedWorker(modulePath, { readPaths = [modulePath], environment = {} } = {}) {
  if (!process.allowedNodeEnvironmentFlags?.has("--permission") || !process.allowedNodeEnvironmentFlags?.has("--allow-net")) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "This Node.js runtime cannot deny worker network access");
  }
  const options = createIsolatedForkOptions({ readPaths, environment });
  if (options.execArgv.some((argument) => argument === "--allow-net" || argument.startsWith("--allow-fs-write"))) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "The worker launch options grant forbidden authority");
  }
  return fork(resolve(modulePath), [], options);
}

export function inspectWorkerLaunchOptions(options) {
  const execArgv = Array.isArray(options?.execArgv) ? options.execArgv : [];
  const environmentNames = Object.keys(options?.env ?? {});
  return deepFreeze({
    permissionModel: execArgv.includes("--permission"),
    networkGranted: execArgv.includes("--allow-net"),
    filesystemWriteGranted: execArgv.some((entry) => entry.startsWith("--allow-fs-write")),
    childProcessGranted: execArgv.includes("--allow-child-process"),
    workerThreadGranted: execArgv.includes("--allow-worker"),
    dangerousEnvironmentVisible: environmentNames.some((name) => FORBIDDEN_ENVIRONMENT.test(name)),
    inheritedEnvironment: options?.env === process.env
  });
}
