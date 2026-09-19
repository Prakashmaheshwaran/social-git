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

test("successful clipboard copy clears the corresponding secret; failed copy retains it", () => {
  // copyText reports success explicitly and only clears through the callback.
  assert.match(app, /async function copyText\(value, confirmation, clearSecret\)/u);
  assert.match(app, /return copied/u);
  assert.match(app, /copy-secret.*copyText\(state\.createdSecret\.value.*\(\) => \{ state\.createdSecret = null; \}\)/su);
  assert.match(app, /copy-invitation.*copyText\(state\.invitation\.token.*\(\) => \{ state\.invitation = null; \}\)/su);
  assert.match(app, /It cannot be shown again\./u);
  assert.match(app, /Reveal the value and copy it manually\./u);
});
