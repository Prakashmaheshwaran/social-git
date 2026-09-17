// @ts-check

import { ApiError, ControlPlaneUnavailableError, SocialGitClient } from "./client.js";
import { renderApp } from "./view.js";

const mount = document.querySelector("#app");
if (!(mount instanceof HTMLElement)) throw new Error("Application root is missing");
/** @type {HTMLElement} */
const root = mount;

const token = sessionStorage.getItem("social-git-token") ?? "";
const client = new SocialGitClient({ token });
/** @type {import('./view.js').ViewState} */
const state = {
  route: routeFromLocation(), signedIn: Boolean(token), busy: false, error: null, notice: null,
  overview: null, keys: null, keysUnavailable: false, backups: null, upgrade: null,
  settingsUnavailable: false, action: null,
};

root.addEventListener("click", (event) => { void handleClick(event); });
root.addEventListener("submit", (event) => { void handleSubmit(event); });
window.addEventListener("hashchange", () => { state.route = routeFromLocation(); state.error = null; state.notice = null; void loadRoute(); });

void loadRoute();

async function loadRoute() {
  render();
  if (state.route === "setup" || !state.signedIn) return;
  state.busy = true;
  try {
    if (["dashboard", "accounts", "activity"].includes(state.route)) state.overview = await client.getOverview();
    if (state.route === "keys") {
      try { state.keys = await client.listApiKeys(); state.keysUnavailable = false; }
      catch (error) { if (error instanceof ControlPlaneUnavailableError) state.keysUnavailable = true; else throw error; }
    }
    if (state.route === "settings") {
      try {
        [state.backups, state.upgrade] = await Promise.all([client.listBackups(), client.getUpgradeStatus()]);
        state.settingsUnavailable = false;
      } catch (error) { if (error instanceof ControlPlaneUnavailableError) state.settingsUnavailable = true; else throw error; }
    }
  } catch (error) { handleError(error); }
  finally { state.busy = false; render(); }
}

/** @param {Event} event */
async function handleClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  if (action === "dismiss-banner") { state.error = null; state.notice = null; return render(); }
  if (action === "signout") {
    client.setToken(""); sessionStorage.removeItem("social-git-token"); state.signedIn = false; state.overview = null; location.hash = "signin"; return render();
  }
  if (action === "toggle-menu") {
    const shell = root.querySelector(".app-shell"); shell?.classList.toggle("menu-open"); target.setAttribute("aria-expanded", String(shell?.classList.contains("menu-open"))); return;
  }
  if (action === "show-account-form") return show("account-form");
  if (action === "hide-account-form") return hide("account-form");
  if (action === "show-key-form") return show("key-form");
  if (action === "hide-key-form") return hide("key-form");
  if (action === "show-connect") {
    const form = root.querySelector(`[data-form="connect"][data-account-id="${cssEscape(target.dataset.id ?? "")}"]`);
    form?.classList.remove("hidden"); form?.querySelector("input")?.focus(); return;
  }
  if (action === "refresh") return loadRoute();
  if (action === "revoke-account" && target.dataset.id) {
    if (!confirm("Revoke this account session? API calls for it will stop immediately.")) return;
    await perform(async () => { await client.revokeAccount(target.dataset.id ?? ""); state.notice = "The account session was revoked."; state.overview = await client.getOverview(); });
  }
  if (action === "revoke-key" && target.dataset.id) {
    if (!confirm("Revoke this API key? Applications using it will lose access immediately.")) return;
    await perform(async () => { await client.revokeApiKey(target.dataset.id ?? ""); state.notice = "The API key was revoked."; state.keys = await client.listApiKeys(); });
  }
  if (action === "create-backup") {
    await perform(async () => { await client.createBackup(); state.notice = "Encrypted backup started."; state.backups = await client.listBackups(); });
  }
}

/** @param {SubmitEvent} event */
async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const kind = form.dataset.form;
  const data = new FormData(form);
  if (kind === "signin") {
    const nextToken = String(data.get("token") ?? "").trim();
    await perform(async () => {
      client.setToken(nextToken); await client.validateSession(); sessionStorage.setItem("social-git-token", nextToken);
      state.signedIn = true; location.hash = "dashboard";
    });
  }
  if (kind === "setup") {
    await perform(async () => {
      const result = /** @type {Record<string,unknown>} */ (await client.setupInstance({ instanceName: String(data.get("instanceName") ?? ""), ownerEmail: String(data.get("ownerEmail") ?? ""), password: String(data.get("password") ?? "") }));
      const setupToken = typeof result.token === "string" ? result.token : "";
      if (setupToken) { client.setToken(setupToken); sessionStorage.setItem("social-git-token", setupToken); state.signedIn = true; }
      state.notice = "Workspace created."; location.hash = setupToken ? "dashboard" : "signin";
    });
  }
  if (kind === "account") {
    await perform(async () => {
      const label = String(data.get("label") ?? "").trim();
      await client.createAccount({ platform: "reddit", expectedNativeUserId: String(data.get("expectedNativeUserId") ?? "").trim(), ...(label ? { label } : {}) });
      state.notice = "Account registered. Connect its staged session when ready."; state.overview = await client.getOverview();
    });
  }
  if (kind === "connect") {
    await perform(async () => {
      await client.importConnection(form.dataset.accountId ?? "", { vaultHandle: String(data.get("vaultHandle") ?? "").trim(), generation: Number(data.get("generation")) });
      form.reset(); state.notice = "Session imported and identity verification started."; state.overview = await client.getOverview();
    });
  }
  if (kind === "key") {
    await perform(async () => {
      const result = /** @type {Record<string,unknown>} */ (await client.createApiKey({ name: String(data.get("name") ?? "").trim(), scopes: data.getAll("scopes").map(String) }));
      const secret = typeof result.secret === "string" ? result.secret : "";
      state.notice = secret ? `Key created. Copy it now; it will not be shown again: ${secret}` : "API key created.";
      state.keys = await client.listApiKeys();
    });
  }
  if (kind === "action") {
    await perform(async () => { state.action = (await client.getAction(String(data.get("actionId") ?? "").trim())).action; });
  }
}

/** @param {() => Promise<void>} task */
async function perform(task) {
  state.busy = true; state.error = null; state.notice = null; render();
  try { await task(); }
  catch (error) { handleError(error); }
  finally { state.busy = false; render(); }
}

/** @param {unknown} error */
function handleError(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) { state.signedIn = false; sessionStorage.removeItem("social-git-token"); }
    state.error = { message: error.message, requestId: error.requestId };
  } else state.error = { message: "An unexpected local error occurred. Refresh and try again." };
}

function render() { root.innerHTML = renderApp(state); }
/** @param {string} region */
function show(region) { const element = root.querySelector(`[data-region="${region}"]`); element?.classList.remove("hidden"); element?.querySelector("input")?.focus(); }
/** @param {string} region */
function hide(region) { root.querySelector(`[data-region="${region}"]`)?.classList.add("hidden"); }
function routeFromLocation() { const route = location.hash.replace(/^#/u, "").split("?")[0] || "dashboard"; return ["dashboard", "accounts", "keys", "activity", "settings", "setup", "signin"].includes(route) ? route : "dashboard"; }
/** @param {string} value */
function cssEscape(value) { return CSS.escape(value); }
