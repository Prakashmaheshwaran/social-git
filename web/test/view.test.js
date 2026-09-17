import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml, renderApp } from "../view.js";

const base = {
  route: "dashboard", signedIn: true, busy: false, error: null, notice: null,
  overview: { accounts: [], connections: {}, audit: [], health: { ready: true, checks: {} } },
  keys: null, keysUnavailable: false, backups: null, upgrade: null, settingsUnavailable: false, action: null,
};

test("dashboard has navigation, health, empty states, and accessible landmarks", () => {
  const html = renderApp(base);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /System operational/);
  assert.match(html, /Add your first account/);
  assert.match(html, /<main id="main"/);
});

test("account and audit values are escaped before rendering", () => {
  const html = renderApp({ ...base, overview: { ...base.overview, accounts: [{ id: "a1", platform: "reddit", expectedNativeUserId: "<img src=x>", actualNativeUserId: null, label: "<script>alert(1)</script>", status: "active", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], connections: { a1: null } } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(escapeHtml('a&<"'), "a&amp;&lt;&quot;");
});

test("missing DYN-104 APIs render honest actionable states rather than fake records", () => {
  const keys = renderApp({ ...base, route: "keys", keysUnavailable: true });
  const settings = renderApp({ ...base, route: "settings", settingsUnavailable: true });
  assert.match(keys, /identity service/);
  assert.match(keys, /Inspect available endpoints/);
  assert.match(settings, /control-plane client is wired/);
  assert.doesNotMatch(keys, /Production automation/);
});

test("signed-out and first-run flows explain token handling and recovery prerequisites", () => {
  const signin = renderApp({ ...base, signedIn: false, overview: null });
  const setup = renderApp({ ...base, route: "setup", signedIn: false, overview: null });
  assert.match(signin, /browser tab only/);
  assert.match(setup, /Configure HTTPS/);
  assert.match(setup, /autocomplete="new-password"/);
});
