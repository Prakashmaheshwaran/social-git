import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { assertExactKeys, deepFreeze } from "./bounds.mjs";
import { SECURITY_ERROR_CODES, fail } from "./errors.mjs";

const ALLOWED_ENVIRONMENT = new Set([
  "NODE_ENV",
  "SOCIAL_GIT_FIXTURE_WORKER",
  "SOCIAL_GIT_FIXTURE_SCENARIO",
  "SOCIAL_GIT_WORKER_ID",
  "SOCIAL_GIT_OS_SANDBOX",
  "__CF_USER_TEXT_ENCODING"
]);
const FORBIDDEN_EXEC_ARG = /(?:allow-net|allow-fs-write|allow-child-process|allow-worker|import|loader|require)/u;
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MACOS_SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  "(deny file-write*)"
].join(" ");

export const WORKER_SANDBOX_POLICY = deepFreeze({
  environment: "positive_allowlist",
  nodePermissionModel: {
    network: "none",
    filesystemRead: "worker_code_only",
    filesystemWrite: "none",
    childProcess: "none",
    workerThreads: "none",
    nativeAddons: "none"
  },
  byteTransport: "length_prefixed_bounded_stdio",
  darwinKernelSandbox: {
    launcher: MACOS_SANDBOX_EXEC,
    network: "deny",
    filesystemWrite: "deny"
  },
  productionContainerRequirements: {
    distinctUid: true,
    distinctGid: true,
    rootFilesystem: "read_only",
    writablePaths: [],
    capabilities: [],
    noNewPrivileges: true,
    network: "none",
    pids: 1,
    nofile: 64,
    memoryBytes: 134_217_728,
    cpuQuotaMicros: 50_000,
    cpuPeriodMicros: 100_000,
    databaseMounts: [],
    keyMounts: [],
    controlPlaneSockets: []
  },
  connector: "trusted_core_egress_broker_only"
});

export function createIsolatedForkOptions({ readPaths, environment = {} }) {
  if (!Array.isArray(readPaths) || readPaths.length < 1 || readPaths.length > 32) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "One or more worker code read paths are required");
  }
  assertExactKeys({ environment }, ["environment"]);
  const cleanEnvironment = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!ALLOWED_ENVIRONMENT.has(name)) {
      fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, `Worker environment variable is not admitted: ${name}`);
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
  const execArgv = ["--permission", ...normalizedPaths.map((path) => `--allow-fs-read=${path}`)];
  assertNoGrantedAuthority(execArgv);
  return deepFreeze({
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnvironment,
    execArgv,
    readPaths: normalizedPaths,
    osSandbox: selectOsSandbox()
  });
}

export function forkIsolatedWorker(modulePath, { readPaths = [modulePath], environment = {} } = {}) {
  if (!process.allowedNodeEnvironmentFlags?.has("--permission") || !process.allowedNodeEnvironmentFlags?.has("--allow-net")) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "This Node.js runtime cannot deny worker network access");
  }
  const options = createIsolatedForkOptions({ readPaths, environment });
  const resolvedModule = resolve(modulePath);
  const command = options.osSandbox.kind === "darwin_sandbox_exec" ? MACOS_SANDBOX_EXEC : process.execPath;
  const args = options.osSandbox.kind === "darwin_sandbox_exec"
    ? ["-p", MACOS_SANDBOX_PROFILE, process.execPath, ...options.execArgv, resolvedModule]
    : [...options.execArgv, resolvedModule];
  const child = spawn(command, args, {
    stdio: options.stdio,
    env: { ...options.env, SOCIAL_GIT_OS_SANDBOX: options.osSandbox.kind },
    windowsHide: true
  });
  Object.defineProperty(child, "workerSecurity", {
    enumerable: false,
    value: deepFreeze({
      command,
      args: [...args],
      osSandbox: options.osSandbox,
      inheritedEnvironment: false
    })
  });
  return child;
}

export function assertEffectiveWorkerPermissions() {
  const forbiddenEnvironmentNames = forbiddenEffectiveEnvironmentNames(process.env);
  const inspection = {
    permissionModel: process.execArgv.includes("--permission"),
    networkGranted: permissionHas("net"),
    filesystemWriteGranted: permissionHas("fs.write"),
    childProcessGranted: permissionHas("child"),
    workerThreadGranted: permissionHas("worker"),
    nativeAddonGranted: permissionHas("addons"),
    forbiddenEnvironmentVisible: forbiddenEnvironmentNames.length > 0,
    osSandbox: process.env.SOCIAL_GIT_OS_SANDBOX ?? "unknown"
  };
  if (
    !inspection.permissionModel || inspection.networkGranted || inspection.filesystemWriteGranted ||
    inspection.childProcessGranted || inspection.workerThreadGranted || inspection.nativeAddonGranted ||
    inspection.forbiddenEnvironmentVisible
  ) {
    fail(
      SECURITY_ERROR_CODES.RUNTIME_ISOLATION,
      `The effective worker process has forbidden authority: ${forbiddenEnvironmentNames.join(",") || "permission"}`
    );
  }
  return deepFreeze(inspection);
}

export function forbiddenEffectiveEnvironmentNames(environment) {
  return Object.entries(environment)
    .filter(([name, value]) => (
      !ALLOWED_ENVIRONMENT.has(name) && !(name === "UV_USE_IO_URING" && value === "0")
    ))
    .map(([name]) => name);
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
    dangerousEnvironmentVisible: environmentNames.some((name) => !ALLOWED_ENVIRONMENT.has(name)),
    inheritedEnvironment: options?.env === process.env,
    byteTransport: Array.isArray(options?.stdio) && options.stdio[0] === "pipe" && options.stdio[1] === "pipe",
    osSandbox: options?.osSandbox?.kind ?? "unknown"
  });
}

export function inspectIsolatedWorker(worker) {
  if (!worker?.workerSecurity || !Number.isSafeInteger(worker.pid)) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "The process was not launched by the isolated worker launcher");
  }
  return deepFreeze({
    pid: worker.pid,
    command: worker.workerSecurity.command,
    osSandbox: worker.workerSecurity.osSandbox.kind,
    inheritedEnvironment: worker.workerSecurity.inheritedEnvironment,
    byteTransport: Boolean(worker.stdin && worker.stdout)
  });
}

function selectOsSandbox() {
  if (platform() === "darwin" && existsSync(MACOS_SANDBOX_EXEC)) {
    return deepFreeze({ kind: "darwin_sandbox_exec", network: "deny", filesystemWrite: "deny" });
  }
  return deepFreeze({ kind: "node_permission_model", network: "deny", filesystemWrite: "deny" });
}

function assertNoGrantedAuthority(execArgv) {
  if (execArgv.some((argument) => FORBIDDEN_EXEC_ARG.test(argument))) {
    fail(SECURITY_ERROR_CODES.RUNTIME_ISOLATION, "The worker launch options grant forbidden authority");
  }
}

function permissionHas(scope) {
  try {
    return process.permission?.has(scope) === true;
  } catch {
    return false;
  }
}
