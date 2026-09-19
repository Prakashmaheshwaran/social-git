import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("one-time secrets are cleared on dismiss, navigation, logout, and reauth", () => {
  assert.match(app, /function clearOneTimeSecrets\(\)/u);
  assert.match(app, /hashchange.*clearOneTimeSecrets\(\)/u);
  assert.match(app, /dismiss-banner.*clearOneTimeSecrets\(\)/su);
  assert.match(app, /copy-secret/u);
  assert.match(app, /dismiss-secret/u);
  assert.match(app, /dismiss-invitation/u);
  assert.match(app, /401.*clearOneTimeSecrets\(\)/su);
});

test("API key creation keeps plaintext out of the banner notice", () => {
  assert.doesNotMatch(app, /Copy it now; it will not be shown again: \$\{secret\}/u);
  assert.match(app, /masked by default/u);
});
