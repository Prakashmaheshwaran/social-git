import assert from "node:assert/strict";

import {
  PLATFORM_FAILURES,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  candidateVerdict,
  validateDriver,
} from "./contract.mjs";

const ACCOUNT_ALPHA = Object.freeze({
  accountId: "acct-alpha",
  expectedIdentity: "qa_alpha",
  routeId: "route-alpha",
  sessionFixture: "session-alpha-v1",
});

const ACCOUNT_BETA = Object.freeze({
  accountId: "acct-beta",
  expectedIdentity: "qa_beta",
  routeId: "route-beta",
  sessionFixture: "session-beta-v1",
});

function caller(overrides = {}) {
  return {
    callerId: "qa-caller-a",
    scopes: [],
    ...overrides,
  };
}

function writeCaller(operation, idempotencyKey, overrides = {}) {
  return caller({
    idempotencyKey,
    scopes: [`reddit.${operation}`],
    ...overrides,
  });
}

function responseData(response) {
  assert.ok(response && typeof response === "object", "driver response must be an object");
  assert.ok(Number.isInteger(response.status), "driver response must include an integer status");
  assert.ok(response.body && typeof response.body === "object", "driver response must include a body object");
  return response.body.data ?? response.body.result;
}

function assertSuccess(response, expectedStatus = null) {
  if (expectedStatus === null) {
    assert.ok(response.status >= 200 && response.status < 300, `expected 2xx, got ${response.status}`);
  } else {
    assert.equal(response.status, expectedStatus);
  }

  return responseData(response);
}

function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.body?.error?.code, code);
  assert.equal(typeof response.body.error.message, "string");
  assert.ok(response.body.error.message.length > 0);
}

function assertNativeReference(value, label) {
  assert.equal(typeof value.nativeId, "string", `${label} must return nativeId`);
  assert.ok(value.nativeId.length > 0, `${label} nativeId must not be empty`);
  assert.equal(typeof value.canonicalUrl, "string", `${label} must return canonicalUrl`);
  const parsed = new URL(value.canonicalUrl);
  assert.match(parsed.hostname, /(^|\.)reddit\.com$/);
}

async function configureAccount(driver, account, options = {}) {
  await driver.control("platform-session", {
    sessionFixture: account.sessionFixture,
    nativeIdentity: options.nativeIdentity ?? account.expectedIdentity,
    syntheticSensitiveFields: options.syntheticSensitiveFields ?? {},
  });

  return driver.call("session.import", {
    accountId: account.accountId,
    expectedIdentity: account.expectedIdentity,
    routeId: account.routeId,
    sessionFixture: account.sessionFixture,
    syntheticSensitiveFields: options.syntheticSensitiveFields ?? {},
  }, caller());
}

async function activateAccount(driver, account = ACCOUNT_ALPHA) {
  const imported = await configureAccount(driver, account);
  const data = assertSuccess(imported, 201);
  assert.equal(data.accountId, account.accountId);
  assert.equal(data.identity, account.expectedIdentity);

  const validated = assertSuccess(await driver.call("session.validate", {
    accountId: account.accountId,
  }, caller()));
  assert.equal(validated.state, "ACTIVE");
  assert.equal(validated.identity, account.expectedIdentity);
}

function platformOperationCount(calls, operation) {
  return calls.filter((entry) => entry.operation === operation).length;
}

async function accountsSessionsRoutes(driver) {
  await driver.reset();
  await activateAccount(driver, ACCOUNT_ALPHA);
  await activateAccount(driver, ACCOUNT_BETA);

  const alphaProfile = assertSuccess(await driver.call("read.account-profile", {
    accountId: ACCOUNT_ALPHA.accountId,
  }, caller()));
  const betaProfile = assertSuccess(await driver.call("read.account-profile", {
    accountId: ACCOUNT_BETA.accountId,
  }, caller()));
  assert.equal(alphaProfile.identity, ACCOUNT_ALPHA.expectedIdentity);
  assert.equal(betaProfile.identity, ACCOUNT_BETA.expectedIdentity);
  assert.notEqual(alphaProfile.nativeId, betaProfile.nativeId);

  const calls = await driver.inspect("platform-calls");
  const profileCalls = calls.filter((entry) => entry.operation === "read.account-profile");
  assert.deepEqual(profileCalls.map((entry) => ({
    accountId: entry.accountId,
    routeId: entry.routeId,
  })), [
    { accountId: ACCOUNT_ALPHA.accountId, routeId: ACCOUNT_ALPHA.routeId },
    { accountId: ACCOUNT_BETA.accountId, routeId: ACCOUNT_BETA.routeId },
  ]);

  const wrongIdentity = {
    accountId: "acct-wrong-identity",
    expectedIdentity: "qa_expected",
    routeId: "route-wrong-identity",
    sessionFixture: "session-wrong-identity-v1",
  };
  const rejected = await configureAccount(driver, wrongIdentity, { nativeIdentity: "qa_unexpected" });
  assertError(rejected, 409, "WRONG_IDENTITY");
  assertError(await driver.call("read.account-profile", {
    accountId: wrongIdentity.accountId,
  }, caller()), 401, "SESSION_NOT_ACTIVE");

  const missingRoute = {
    accountId: "acct-missing-route",
    expectedIdentity: "qa_missing_route",
    routeId: null,
    sessionFixture: "session-missing-route-v1",
  };
  const beforeMissingRoute = (await driver.inspect("platform-calls")).length;
  assertError(await configureAccount(driver, missingRoute), 400, "NETWORK_ROUTE_REQUIRED");
  assert.equal((await driver.inspect("platform-calls")).length, beforeMissingRoute);

  const refreshedFixture = "session-beta-v2";
  await driver.control("platform-session", {
    sessionFixture: refreshedFixture,
    nativeIdentity: ACCOUNT_BETA.expectedIdentity,
  });
  const refreshed = assertSuccess(await driver.call("session.refresh", {
    accountId: ACCOUNT_BETA.accountId,
    routeId: "route-beta-v2",
    sessionFixture: refreshedFixture,
    generation: 2,
  }, caller()));
  assert.equal(refreshed.state, "ACTIVE");
  assert.equal(refreshed.generation, 2);
  assertSuccess(await driver.call("read.account-profile", {
    accountId: ACCOUNT_BETA.accountId,
  }, caller()));
  const refreshedProfileCall = (await driver.inspect("platform-calls"))
    .filter((entry) => entry.operation === "read.account-profile" && entry.accountId === ACCOUNT_BETA.accountId)
    .at(-1);
  assert.equal(refreshedProfileCall.routeId, "route-beta-v2");

  assertSuccess(await driver.call("session.revoke", {
    accountId: ACCOUNT_ALPHA.accountId,
  }, caller()), 204);
  const health = assertSuccess(await driver.call("account.health", {
    accountId: ACCOUNT_ALPHA.accountId,
  }, caller()));
  assert.equal(health.state, "REVOKED");

  const beforeRevokedRead = (await driver.inspect("platform-calls")).length;
  assertError(await driver.call("read.account-profile", {
    accountId: ACCOUNT_ALPHA.accountId,
  }, caller()), 401, "SESSION_REVOKED");
  assert.equal((await driver.inspect("platform-calls")).length, beforeRevokedRead);

  const betaAfterAlphaRevocation = assertSuccess(await driver.call("read.account-profile", {
    accountId: ACCOUNT_BETA.accountId,
  }, caller()));
  assert.equal(betaAfterAlphaRevocation.identity, ACCOUNT_BETA.expectedIdentity);
}

async function readContracts(driver) {
  await driver.reset();
  await activateAccount(driver);

  for (const operation of READ_OPERATIONS) {
    const data = assertSuccess(await driver.call(operation, {
      accountId: ACCOUNT_ALPHA.accountId,
      subreddit: "qualityassurance",
      nativeId: "t3_fixture_post",
      query: "deterministic fixture",
    }, caller()));
    assertNativeReference(data, operation);
  }
}

function writeInput(operation, targetNativeId = "t3_owned_fixture") {
  return {
    accountId: ACCOUNT_ALPHA.accountId,
    subreddit: "qualityassurance",
    title: `Fixture ${operation}`,
    body: "Synthetic fixture content",
    url: "https://example.test/fixture",
    mediaFixture: "media-fixture-1",
    parentNativeId: "t1_fixture_parent",
    targetNativeId,
    direction: 1,
  };
}

async function writeContractsAndDeletion(driver) {
  await driver.reset();
  await activateAccount(driver);
  await driver.control("seed-owned", {
    accountId: ACCOUNT_ALPHA.accountId,
    nativeIds: ["t3_owned_fixture"],
  });

  const beforeUnauthorized = (await driver.inspect("platform-calls")).length;
  assertError(await driver.call("write.post.text", writeInput("write.post.text"), caller({
    idempotencyKey: "unauthorized-write",
  })), 403, "SCOPE_REQUIRED");
  assert.equal((await driver.inspect("platform-calls")).length, beforeUnauthorized);

  for (const [index, operation] of WRITE_OPERATIONS.entries()) {
    if (operation === "write.delete") {
      continue;
    }

    const before = platformOperationCount(await driver.inspect("platform-calls"), operation);
    const response = await driver.call(
      operation,
      writeInput(operation),
      writeCaller(operation, `write-contract-${index}`),
    );
    const result = assertSuccess(response);
    assert.equal(result.state, "CONFIRMED", `${operation} must return a confirmed result`);
    assert.equal(typeof result.actionId, "string");
    assertNativeReference(result, operation);
    assert.equal(
      platformOperationCount(await driver.inspect("platform-calls"), operation),
      before + 1,
      `${operation} must reach the platform exactly once`,
    );

    // Media writes stage a fresh account-scoped media reference on every call,
    // so an identical replay body does not exist for this kind. The idempotency
    // contract is covered for every other write kind below and for media by the
    // conflict assertion in idempotency-restart-concurrency.
    if (operation === "write.post.media") continue;

    const replay = await driver.call(
      operation,
      writeInput(operation),
      writeCaller(operation, `write-contract-${index}`),
    );
    assert.deepEqual(replay, response, `${operation} must replay the same caller idempotency key`);
    assert.equal(
      platformOperationCount(await driver.inspect("platform-calls"), operation),
      before + 1,
      `${operation} replay must not dispatch again`,
    );
  }

  const beforeForeignEdit = platformOperationCount(
    await driver.inspect("platform-calls"),
    "write.edit-own",
  );
  assertError(await driver.call(
    "write.edit-own",
    writeInput("write.edit-own", "t3_foreign_fixture"),
    writeCaller("write.edit-own", "edit-foreign"),
  ), 403, "OWNERSHIP_REQUIRED");
  assert.equal(platformOperationCount(
    await driver.inspect("platform-calls"),
    "write.edit-own",
  ), beforeForeignEdit);

  const beforeForeignDelete = platformOperationCount(
    await driver.inspect("platform-calls"),
    "write.delete",
  );
  assertError(await driver.call(
    "write.delete",
    writeInput("write.delete", "t3_foreign_fixture"),
    writeCaller("write.delete", "delete-foreign"),
  ), 403, "OWNERSHIP_REQUIRED");
  assert.equal(platformOperationCount(
    await driver.inspect("platform-calls"),
    "write.delete",
  ), beforeForeignDelete);

  const deleted = assertSuccess(await driver.call(
    "write.delete",
    writeInput("write.delete", "t3_owned_fixture"),
    writeCaller("write.delete", "delete-own"),
  ));
  assert.equal(deleted.state, "CONFIRMED");
  assertNativeReference(deleted, "write.delete");
}

async function idempotencyRestartConcurrency(driver) {
  await driver.reset();
  await activateAccount(driver);

  const operation = "write.comment";
  const input = writeInput(operation);
  const context = writeCaller(operation, "stable-key");
  const first = await driver.call(operation, input, context);
  assertSuccess(first);
  const afterFirst = platformOperationCount(await driver.inspect("platform-calls"), operation);

  const duplicate = await driver.call(operation, input, context);
  assert.deepEqual(duplicate, first);
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterFirst);

  await driver.control("restart");
  const afterRestart = await driver.call(operation, input, context);
  assert.deepEqual(afterRestart, first);
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterFirst);

  assertError(await driver.call(operation, {
    ...input,
    body: "Conflicting payload",
  }, context), 409, "IDEMPOTENCY_CONFLICT");
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterFirst);

  const secondCaller = await driver.call(operation, input, writeCaller(operation, "stable-key", {
    callerId: "qa-caller-b",
  }));
  assertSuccess(secondCaller);
  assert.notDeepEqual(secondCaller.body, first.body);
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterFirst + 1);

  const concurrentContext = writeCaller(operation, "concurrent-key");
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => (
    driver.call(operation, input, concurrentContext)
  )));
  for (const response of concurrent) {
    assert.deepEqual(response, concurrent[0]);
  }
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterFirst + 2);
}

async function failClosedPlatformErrors(driver) {
  await driver.reset();
  await activateAccount(driver);

  for (const [outcome, status, code] of PLATFORM_FAILURES) {
    await driver.control("next-platform-outcome", {
      accountId: ACCOUNT_ALPHA.accountId,
      operation: "read.post",
      outcome,
    });
    const before = platformOperationCount(await driver.inspect("platform-calls"), "read.post");
    assertError(await driver.call("read.post", {
      accountId: ACCOUNT_ALPHA.accountId,
      nativeId: "t3_fixture_post",
    }, caller()), status, code);
    assert.equal(
      platformOperationCount(await driver.inspect("platform-calls"), "read.post"),
      before + 1,
      `${outcome} must stop without an automatic retry`,
    );

    const writeOperation = "write.comment";
    await driver.control("next-platform-outcome", {
      accountId: ACCOUNT_ALPHA.accountId,
      operation: writeOperation,
      outcome,
    });
    const beforeWrite = platformOperationCount(await driver.inspect("platform-calls"), writeOperation);
    const writeContext = writeCaller(writeOperation, `platform-failure-${outcome}`);
    const writeResponse = await driver.call(writeOperation, writeInput(writeOperation), writeContext);
    assertError(writeResponse, status, code);
    assert.equal(
      platformOperationCount(await driver.inspect("platform-calls"), writeOperation),
      beforeWrite + 1,
      `${outcome} write must stop without an automatic retry`,
    );
    assert.deepEqual(
      await driver.call(writeOperation, writeInput(writeOperation), writeContext),
      writeResponse,
    );
    assert.equal(
      platformOperationCount(await driver.inspect("platform-calls"), writeOperation),
      beforeWrite + 1,
      `${outcome} write result must be replayed without a new dispatch`,
    );
  }

  assertSuccess(await driver.call("session.revoke", {
    accountId: ACCOUNT_ALPHA.accountId,
  }, caller()), 204);
  const beforeRevoked = (await driver.inspect("platform-calls")).length;
  assertError(await driver.call("read.search", {
    accountId: ACCOUNT_ALPHA.accountId,
    query: "must not reach platform",
  }, caller()), 401, "SESSION_REVOKED");
  assert.equal((await driver.inspect("platform-calls")).length, beforeRevoked);
}

async function crashAfterSubmitAndUnknown(driver) {
  await driver.reset();
  await activateAccount(driver);

  const operation = "write.comment";
  const input = writeInput(operation);
  const context = writeCaller(operation, "crash-after-submit-key");
  await driver.control("crash-after-submit", {
    accountId: ACCOUNT_ALPHA.accountId,
    operation,
  });

  const initial = await driver.call(operation, input, context);
  const initialResult = assertSuccess(initial, 202);
  assert.equal(initialResult.state, "UNKNOWN");
  assert.equal(typeof initialResult.actionId, "string");
  const actionId = initialResult.actionId;
  const afterCrash = platformOperationCount(await driver.inspect("platform-calls"), operation);
  assert.equal(afterCrash, 1);

  await driver.control("restart");
  const duplicate = await driver.call(operation, input, context);
  assert.deepEqual(duplicate, initial);
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterCrash);

  const action = assertSuccess(await driver.call("action.get", { actionId }, caller()));
  assert.equal(action.state, "UNKNOWN");

  await driver.control("reconciliation-outcome", { actionId, outcome: "not_found" });
  const unresolved = assertSuccess(await driver.call("action.reconcile", { actionId }, caller()), 202);
  assert.equal(unresolved.state, "UNKNOWN");
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterCrash);

  await driver.control("reconciliation-outcome", {
    actionId,
    outcome: "confirmed",
    nativeId: "t1_reconciled_fixture",
    canonicalUrl: "https://www.reddit.com/r/qualityassurance/comments/fixture/reconciled/",
  });
  const reconciled = assertSuccess(await driver.call("action.reconcile", { actionId }, caller()));
  assert.equal(reconciled.state, "CONFIRMED");
  assertNativeReference(reconciled, "reconciled action");
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterCrash);

  const afterReconciliation = assertSuccess(await driver.call(operation, input, context));
  assert.deepEqual(afterReconciliation, reconciled);
  assert.equal(platformOperationCount(await driver.inspect("platform-calls"), operation), afterCrash);
}

async function secretLogRedaction(driver) {
  await driver.reset();
  const sentinels = [
    "SYNTHETIC_COOKIE_SENTINEL_7eb1",
    "SYNTHETIC_CSRF_SENTINEL_b59c",
    "SYNTHETIC_MFA_SENTINEL_43d2",
    "SYNTHETIC_ROUTE_SENTINEL_d90a",
  ];
  const syntheticSensitiveFields = {
    sessionEnvelope: sentinels[0],
    csrfValue: sentinels[1],
    mfaCode: sentinels[2],
    routeMaterial: sentinels[3],
  };
  const imported = await configureAccount(driver, ACCOUNT_ALPHA, { syntheticSensitiveFields });
  assertSuccess(imported, 201);
  const read = await driver.call("read.account-profile", {
    accountId: ACCOUNT_ALPHA.accountId,
    syntheticSensitiveFields,
  }, caller());
  assertSuccess(read);

  const observable = JSON.stringify({
    imported,
    read,
    logs: await driver.inspect("logs"),
    audit: await driver.inspect("audit-events"),
  });
  const storageRecords = await driver.inspect("storage-records");
  const stored = JSON.stringify(storageRecords);
  for (const sentinel of sentinels) {
    assert.equal(observable.includes(sentinel), false, `observable output leaked ${sentinel}`);
    assert.equal(stored.includes(sentinel), false, `stored record leaked ${sentinel}`);
  }
  assert.ok(storageRecords.length >= 2, "session and route records must be stored independently");
  for (const record of storageRecords) {
    assert.equal(record.encrypted, true);
    assert.equal(record.accountId, ACCOUNT_ALPHA.accountId);
    assert.equal(typeof record.purpose, "string");
    assert.ok(record.purpose.length > 0);
    assert.equal(typeof record.generation, "number");
    assert.ok(record.generation > 0);
    assert.equal(typeof record.nonceId, "string");
    assert.ok(record.nonceId.length > 0);
  }
  assert.equal(new Set(storageRecords.map(({ nonceId }) => nonceId)).size, storageRecords.length);
}

async function productionImageNoBrowser(driver) {
  await driver.reset();
  const inspection = await driver.inspect("production-image");
  assert.ok(inspection && typeof inspection === "object");
  assert.ok(["image_tar", "oci_registry"].includes(inspection.source?.kind));
  assert.equal(inspection.source?.digest, driver.metadata.imageDigest);
  assert.equal(inspection.provenance, "independent_inventory");
  assert.deepEqual(inspection.browserExecutables, []);

  const forbidden = ["playwright", "selenium", "chromium", "chrome", "puppeteer", "chromedriver", "cdp"];
  const inventory = JSON.stringify({
    dependencies: inspection.dependencies,
    runtimeFiles: inspection.runtimeFiles,
    imageCommands: inspection.imageCommands,
    runtimeProcesses: inspection.runtimeProcesses,
  }).toLowerCase();
  for (const token of forbidden) {
    assert.equal(inventory.includes(token), false, `production image contains prohibited browser token: ${token}`);
  }
}

export const SCENARIOS = Object.freeze([
  ["accounts-sessions-routes", accountsSessionsRoutes],
  ["read-contracts", readContracts],
  ["write-contracts-and-deletion", writeContractsAndDeletion],
  ["idempotency-restart-concurrency", idempotencyRestartConcurrency],
  ["fail-closed-platform-errors", failClosedPlatformErrors],
  ["crash-after-submit-and-unknown", crashAfterSubmitAndUnknown],
  ["secret-log-redaction", secretLogRedaction],
  ["production-image-no-browser", productionImageNoBrowser],
]);

export async function runAcceptance(driver) {
  validateDriver(driver);
  const results = [];

  try {
    for (const [name, scenario] of SCENARIOS) {
      try {
        await scenario(driver);
        results.push({ name, status: "PASS" });
      } catch (error) {
        results.push({
          name,
          status: "FAIL",
          failure: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await driver.close();
  }

  return {
    schemaVersion: 1,
    suiteId: "social-git-reddit-mvp-v1",
    evidenceClass: driver.metadata.kind === "integration_candidate"
      ? "deterministic_candidate"
      : "fixture_self_test",
    candidate: {
      kind: driver.metadata.kind,
      candidateRef: driver.metadata.candidateRef ?? null,
      imageDigest: driver.metadata.imageDigest ?? null,
    },
    scenarios: results,
    verdict: candidateVerdict(driver.metadata, results),
  };
}
