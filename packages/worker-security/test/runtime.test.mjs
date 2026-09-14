import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  SECURITY_ERROR_CODES,
  WORKER_SANDBOX_POLICY,
  BoundedFrameDecoder,
  createIsolatedForkOptions,
  decodeBoundedJson,
  encodeBoundedJson,
  forkIsolatedWorker,
  inspectIsolatedWorker,
  writeLengthPrefixedFrame,
  inspectWorkerLaunchOptions
} from "../src/index.mjs";
import { forbiddenEffectiveEnvironmentNames } from "../src/runtime.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const probePath = join(packageRoot, "src", "isolation-probe.mjs");

test("worker launch options are deny-by-default and reject sensitive environment names", () => {
  const options = createIsolatedForkOptions({
    readPaths: [join(packageRoot, "src")],
    environment: { NODE_ENV: "test", SOCIAL_GIT_WORKER_ID: "fixture-1" }
  });
  const inspection = inspectWorkerLaunchOptions(options);
  assert.deepEqual(inspection, {
    permissionModel: true,
    networkGranted: false,
    filesystemWriteGranted: false,
    childProcessGranted: false,
    workerThreadGranted: false,
    dangerousEnvironmentVisible: false,
    inheritedEnvironment: false,
    byteTransport: true,
    osSandbox: process.platform === "darwin" ? "darwin_sandbox_exec" : "node_permission_model"
  });
  for (const name of [
    "HTTP_PROXY", "DATABASE_URL", "SESSION_KEY", "PAPERCLIP_API_URL",
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_V8_COVERAGE", "OPENSSL_CONF"
  ]) {
    assert.throws(
      () => createIsolatedForkOptions({ readPaths: [probePath], environment: { [name]: "sentinel" } }),
      hasCode(SECURITY_ERROR_CODES.RUNTIME_ISOLATION)
    );
  }
  assert.throws(
    () => forkIsolatedWorker(probePath, {
      readPaths: [join(packageRoot, "src")],
      environment: { NODE_OPTIONS: "--allow-net --allow-fs-read=/etc/hosts" }
    }),
    hasCode(SECURITY_ERROR_CODES.RUNTIME_ISOLATION)
  );
  assert.throws(
    () => createIsolatedForkOptions({ readPaths: [probePath], environment: { UV_USE_IO_URING: "0" } }),
    hasCode(SECURITY_ERROR_CODES.RUNTIME_ISOLATION)
  );
  assert.deepEqual(forbiddenEffectiveEnvironmentNames({ NODE_ENV: "test", UV_USE_IO_URING: "0" }), []);
  assert.deepEqual(forbiddenEffectiveEnvironmentNames({ NODE_ENV: "test", UV_USE_IO_URING: "1" }), ["UV_USE_IO_URING"]);
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
      readPaths: [join(packageRoot, "src")],
      environment: { NODE_ENV: "test", SOCIAL_GIT_WORKER_ID: "fixture-1" }
    });
    t.after(() => worker.kill("SIGTERM"));
    const live = inspectIsolatedWorker(worker);
    assert.equal(live.byteTransport, true);
    assert.equal(live.inheritedEnvironment, false);
    assert.equal(live.osSandbox, process.platform === "darwin" ? "darwin_sandbox_exec" : "node_permission_model");
    const result = await new Promise((resolve, reject) => {
      let stderr = "";
      worker.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 4096);
      });
      const decoder = new BoundedFrameDecoder({
        maxBytes: 64 * 1024,
        onFrame: (frame) => resolve(decodeBoundedJson(frame))
      });
      worker.stdout.on("data", (chunk) => decoder.push(chunk));
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== null && code !== 0) reject(new Error(`probe exited with ${code}: ${stderr}`));
      });
      writeLengthPrefixedFrame(
        worker.stdin,
        encodeBoundedJson({ databasePath, keyPath }),
        64 * 1024
      ).catch(reject);
    });
    assert.deepEqual({ ...result, runtime: undefined }, {
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
      proxyEnvironmentVisible: false,
      runtime: undefined
    });
    assert.deepEqual(result.runtime, {
      permissionModel: true,
      networkGranted: false,
      filesystemWriteGranted: false,
      childProcessGranted: false,
      workerThreadGranted: false,
      nativeAddonGranted: false,
      forbiddenEnvironmentVisible: false,
      osSandbox: process.platform === "darwin" ? "darwin_sandbox_exec" : "node_permission_model"
    });
  } finally {
    restore("DATABASE_URL", original.database);
    restore("SESSION_KEY", original.key);
    restore("PAPERCLIP_API_URL", original.control);
    restore("HTTP_PROXY", original.proxy);
  }

  assert.equal(WORKER_SANDBOX_POLICY.environment, "positive_allowlist");
  assert.equal(WORKER_SANDBOX_POLICY.byteTransport, "length_prefixed_bounded_stdio");
  assert.equal(WORKER_SANDBOX_POLICY.nodePermissionModel.network, "none");
  assert.equal(WORKER_SANDBOX_POLICY.productionContainerRequirements.distinctUid, true);
  assert.equal(WORKER_SANDBOX_POLICY.productionContainerRequirements.noNewPrivileges, true);
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
