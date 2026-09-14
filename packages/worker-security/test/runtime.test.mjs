import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SECURITY_ERROR_CODES,
  WORKER_SANDBOX_POLICY,
  createIsolatedForkOptions,
  forkIsolatedWorker,
  inspectWorkerLaunchOptions
} from "../src/index.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const probePath = join(packageRoot, "src", "isolation-probe.mjs");

test("worker launch options are deny-by-default and reject sensitive environment names", () => {
  const options = createIsolatedForkOptions({
    readPaths: [join(packageRoot, "src")],
    environment: { NODE_ENV: "test", SOCIAL_GIT_WORKER_ID: "fixture-1" }
  });
  assert.deepEqual(inspectWorkerLaunchOptions(options), {
    permissionModel: true,
    networkGranted: false,
    filesystemWriteGranted: false,
    childProcessGranted: false,
    workerThreadGranted: false,
    dangerousEnvironmentVisible: false,
    inheritedEnvironment: false
  });
  for (const name of ["HTTP_PROXY", "DATABASE_URL", "SESSION_KEY", "PAPERCLIP_API_URL"]) {
    assert.throws(
      () => createIsolatedForkOptions({ readPaths: [probePath], environment: { [name]: "sentinel" } }),
      hasCode(SECURITY_ERROR_CODES.RUNTIME_ISOLATION)
    );
  }
});

test("runtime probe cannot read SQLite or keys and receives no network, proxy, or control-plane authority", async (t) => {
  const scratchRoot = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR;
  const fixtureDirectory = scratchRoot
    ? join(scratchRoot, `worker-security-${process.pid}`)
    : await mkdtemp(join(tmpdir(), "social-git-worker-security-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const databasePath = join(fixtureDirectory, "social-git.sqlite");
  const keyPath = join(fixtureDirectory, "worker.key");
  await mkdir(fixtureDirectory, { recursive: true });
  await writeFile(databasePath, "database-canary", { mode: 0o600 });
  await writeFile(keyPath, "key-canary", { mode: 0o600 });

  const original = {
    database: process.env.DATABASE_URL,
    key: process.env.SESSION_KEY,
    control: process.env.PAPERCLIP_API_URL,
    proxy: process.env.HTTP_PROXY
  };
  process.env.DATABASE_URL = `sqlite://${databasePath}`;
  process.env.SESSION_KEY = "key-environment-canary";
  process.env.PAPERCLIP_API_URL = "http://127.0.0.1:9000";
  process.env.HTTP_PROXY = "http://127.0.0.1:3128";
  try {
    const worker = forkIsolatedWorker(probePath, {
      readPaths: [probePath],
      environment: { NODE_ENV: "test", SOCIAL_GIT_WORKER_ID: "fixture-1" }
    });
    t.after(() => worker.kill("SIGTERM"));
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`probe exited with ${code}`));
      });
      worker.send({ databasePath, keyPath });
    });
    assert.deepEqual(result, {
      databaseReadable: false,
      databaseReadErrorCode: "ERR_ACCESS_DENIED",
      keyReadable: false,
      keyReadErrorCode: "ERR_ACCESS_DENIED",
      filesystemWriteGranted: false,
      networkGranted: false,
      networkConnectDeniedByRuntime: true,
      databaseEnvironmentVisible: false,
      keyEnvironmentVisible: false,
      controlPlaneEnvironmentVisible: false,
      proxyEnvironmentVisible: false
    });
  } finally {
    restore("DATABASE_URL", original.database);
    restore("SESSION_KEY", original.key);
    restore("PAPERCLIP_API_URL", original.control);
    restore("HTTP_PROXY", original.proxy);
  }

  assert.deepEqual(WORKER_SANDBOX_POLICY, {
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
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
