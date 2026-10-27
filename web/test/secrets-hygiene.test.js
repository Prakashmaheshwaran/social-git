import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const client = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const view = readFileSync(new URL("../view.js", import.meta.url), "utf8");

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

test("API key rotation reuses the copy-once panel and never writes plaintext to a notice", () => {
  assert.match(app, /rotate-key.*client\.rotateApiKey/su);
  assert.match(app, /rotate-key.*state\.createdSecret = result\.secret \? \{ value: result\.secret, revealed: false \}/su);
  assert.doesNotMatch(app, /\$\{result\.secret\}/u, "the rotated secret is never interpolated into a banner");
  assert.doesNotMatch(app, /localStorage|sessionStorage/u);
});

test("the browser bundle never persists secrets or joins them to a URL", () => {
  for (const source of [app, client, view]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage/u);
    assert.doesNotMatch(source, /console\.(log|info|debug|warn|error)\(/, "secrets must never be logged");
  }
  // Server secrets are always carried in the JSON body, never path/query.
  assert.doesNotMatch(client, /rotate\?secret=|secret=\$\{|token=\$\{/u);
});

test("invitation acceptance keeps the token out of the URL and clears the form field", () => {
  assert.match(client, /\/v1\/invitations\/accept/u);
  assert.match(client, /body: \{ token: input\.token, displayName: input\.displayName, password: input\.password \}/u);
  assert.match(app, /kind === "accept-invitation"[\s\S]*?form\.reset\(\)/u);
  assert.doesNotMatch(app, /accept-invitation[\s\S]{0,600}location\.hash = [`"]?\$\{/u);
  assert.doesNotMatch(app, /location\.hash[^\n]*token/u);
  assert.doesNotMatch(view, /name="token"[^>]*value=/u);
});

test("webhook signing secrets use the same masked one-time surface and are cleared with the others", () => {
  assert.match(app, /reveal-webhook-secret/u);
  assert.match(app, /hide-webhook-secret/u);
  assert.match(app, /copy-webhook-secret/u);
  assert.match(app, /dismiss-webhook-secret/u);
  assert.match(app, /function clearOneTimeSecrets\(\) \{[\s\S]*?state\.webhookSecret = null;[\s\S]*?\}/u);
  assert.match(app, /copy-webhook-secret.*copyText\(state\.webhookSecret\.value.*\(\) => \{ state\.webhookSecret = null; \}\)/su);
  assert.match(app, /createWebhookSubscription[\s\S]{0,500}state\.webhookSecret = result\.secret \? \{ value: result\.secret, revealed: false \}/u);
  assert.match(app, /rotateWebhookSecret[\s\S]{0,500}state\.webhookSecret = result\.secret \? \{ value: result\.secret, revealed: false \}/u);
  assert.doesNotMatch(app, /\$\{result\.secret\}/u, "webhook plaintext is never interpolated into a banner");
  assert.match(view, /ONE-TIME WEBHOOK SECRET/u);
  assert.match(view, /"reveal-webhook-secret" : "hide-webhook-secret"|"hide-webhook-secret" : "reveal-webhook-secret"/u);
  assert.doesNotMatch(view, /webhookSecret[\s\S]{0,80}href=/u);
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
