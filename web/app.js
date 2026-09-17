// @ts-check

import { ApiError, ControlPlaneUnavailableError, SocialGitClient } from "./client.js";
import { renderApp } from "./view.js";

const mount = document.querySelector("#app");
if (!(mount instanceof HTMLElement)) throw new Error("Application root is missing");
/** @type {HTMLElement} */
const root = mount;

const client = new SocialGitClient();
/** @type {import('./view.js').ViewState} */
const state = {
  route: routeFromLocation(), signedIn: false, mutationReady: false, busy: true, error: null, notice: null,
  overview: null, keys: null, keysUnavailable: false, backups: null, upgrade: null,
  settingsUnavailable: false, action: null, jobs: null, usage: null, session: null, workspaces: null, members: null, invitation: null,
};

root.addEventListener("click", (event) => { void handleClick(event); });
root.addEventListener("submit", (event) => { void handleSubmit(event); });
root.addEventListener("change", handleChange);
window.addEventListener("hashchange", () => { state.route = routeFromLocation(); state.error = null; state.notice = null; void loadRoute(); });

void bootstrap();

async function bootstrap() {
  render();
  try {
    const setup = await client.getSetupStatus();
    if (setup.required) {
      state.signedIn = false;
      state.route = "setup";
      if (location.hash !== "#setup") location.hash = "setup";
      return;
    }
    try {
      state.session = await client.getSession();
      state.signedIn = true;
      state.mutationReady = false;
      if (["setup", "signin"].includes(state.route)) {
        state.route = "dashboard";
        location.hash = "dashboard";
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      state.signedIn = false;
      state.route = "signin";
      if (location.hash !== "#signin") location.hash = "signin";
    }
  } catch (error) { handleError(error); }
  finally { state.busy = false; await loadRoute(); }
}

async function loadRoute() {
  render();
  if (state.route === "setup" || state.route === "signin" || !state.signedIn) return;
  state.busy = true;
  try {
    if (["dashboard", "accounts"].includes(state.route)) state.overview = await client.getOverview();
    if (state.route === "activity") {
      [state.overview, state.jobs, state.usage] = await Promise.all([client.getOverview(), client.listActions(), client.getUsage()]);
    }
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
    if (state.route === "team") {
      state.session = await client.getSession();
      state.workspaces = await client.listWorkspaces();
      state.members = state.session.role === "owner" ? await client.listMembers() : { items: [], nextCursor: null };
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
    if (!client.hasMutationSession()) {
      state.notice = "Confirm your password to securely end the restored session.";
      location.hash = "signin";
      return render();
    }
    await perform(async () => { await client.logout(); state.signedIn = false; state.mutationReady = false; state.overview = null; location.hash = "signin"; });
    return;
  }
  if (action === "reauthenticate") { location.hash = "signin"; return; }
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
  if (action === "deactivate-member" && target.dataset.id) {
    if (!confirm("Deactivate this workspace membership and revoke its sessions and API keys?")) return;
    await perform(async () => { await client.updateMember(target.dataset.id ?? "", { status: "inactive" }); state.members = await client.listMembers(); });
    return;
  }
  if (action === "cancel-job" && target.dataset.id) {
    if (!confirm("Cancel this queued action before it is dispatched? Cancellation is terminal.")) return;
    await perform(async () => {
      const result = await client.cancelAction(target.dataset.id ?? "", crypto.randomUUID());
      state.action = result.action;
      state.jobs = await client.listActions();
      state.usage = await client.getUsage();
      state.notice = "The queued action was cancelled before dispatch.";
    });
  }
  if (action === "revoke-account" && target.dataset.id) {
    if (!confirm("Revoke this account session? API calls for it will stop immediately.")) return;
    await perform(async () => { await client.revokeAccount(target.dataset.id ?? ""); state.notice = "The account session was revoked."; state.overview = await client.getOverview(); });
  }
  if (action === "revoke-key" && target.dataset.id) {
    if (!confirm("Revoke this API key? Applications using it will lose access immediately.")) return;
    await perform(async () => { await client.revokeApiKey(target.dataset.id ?? ""); state.notice = "The API key was revoked."; state.keys = await client.listApiKeys(); });
  }
  if (action === "create-backup") {
    await perform(async () => {
      const result = /** @type {{backup?:{id?:string}}} */ (await client.createBackup());
      state.notice = result.backup?.id
        ? `Encrypted three-database backup ${result.backup.id} started.`
        : "Encrypted three-database backup started.";
      state.backups = await client.listBackups();
    });
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
    await perform(async () => {
      state.session = await client.login({ email: String(data.get("email") ?? "").trim(), password: String(data.get("password") ?? "") });
      state.signedIn = true; state.mutationReady = true; state.notice = "Signed in securely."; location.hash = "dashboard";
    });
  }
  if (kind === "setup") {
    await perform(async () => {
      state.session = await client.createOwner({ displayName: String(data.get("displayName") ?? "").trim(), email: String(data.get("email") ?? "").trim(), password: String(data.get("password") ?? "") });
      state.signedIn = true; state.mutationReady = true; state.notice = "Owner account created."; location.hash = "dashboard";
    });
  }
  if (kind === "account") {
    await perform(async () => {
      const label = String(data.get("label") ?? "").trim();
      const platform = data.get("platform") === "x" ? "x" : "reddit";
      await client.createAccount({ platform, expectedNativeUserId: String(data.get("expectedNativeUserId") ?? "").trim(), ...(label ? { label } : {}) });
      state.notice = platform === "x"
        ? "X identity registered for inventory. Production connection and actions remain disabled."
        : "Reddit account registered. Connect its staged session when ready.";
      state.overview = await client.getOverview();
    });
  }
  if (kind === "connect") {
    await perform(async () => {
      const file = data.get("sessionFile");
      if (!(file instanceof File)) throw new ApiError("VALIDATION_FAILED", "Choose the explicitly exported Reddit session JSON file.", 422);
      await client.importRedditSessionFile(form.dataset.accountId ?? "", file);
      form.reset(); state.notice = form.dataset.mode === "refresh" ? "Session generation replaced and identity reverified." : "Session imported into encrypted Core custody and identity verified."; state.overview = await client.getOverview();
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
  if (kind === "member") {
    await perform(async () => {
      const data = new FormData(form);
      await client.provisionMember({ email: String(data.get("email") ?? ""), displayName: String(data.get("displayName") ?? ""), password: String(data.get("password") ?? ""), role: String(data.get("role") ?? "member") });
      state.members = await client.listMembers(); state.notice = "Local member created."; form.reset();
    });
  }
  if (kind === "invitation") {
    await perform(async () => {
      const data = new FormData(form);
      state.invitation = await client.createInvitation({ email: String(data.get("email") ?? ""), role: String(data.get("role") ?? "member") });
      state.notice = "Invitation created. Copy the one-time token now.";
    });
  }
  if (kind === "action") {
    await perform(async () => { state.action = (await client.getAction(String(data.get("actionId") ?? "").trim())).action; });
  }
}

/** @param {Event} event */
function handleChange(event) {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement) || select.dataset.field !== "platform") return;
  const isX = select.value === "x";
  const label = root.querySelector("[data-platform-identity-label]");
  const help = root.querySelector("[data-platform-identity-help]");
  const guidanceTitle = root.querySelector("[data-platform-guidance-title]");
  const guidanceDetail = root.querySelector("[data-platform-guidance-detail]");
  const input = root.querySelector('input[name="expectedNativeUserId"]');
  if (label) label.textContent = isX ? "Expected X numeric user ID" : "Expected Reddit native user ID";
  if (help) help.textContent = isX
    ? "Use X's immutable numeric user ID, not an @handle, email, or display name. Registration does not enable production access."
    : "Use the immutable native ID returned by Reddit, not a display name or email.";
  if (guidanceTitle) guidanceTitle.textContent = isX
    ? "X connection and actions are unavailable in production."
    : "Reddit connects from one explicitly exported session file.";
  if (guidanceDetail) guidanceDetail.textContent = isX
    ? "Registration creates inventory only. The UI will show every machine-readable admission reason and will not accept X session material."
    : "Export the owner-authorized Reddit session as the documented JSON file, then upload it here. Social Git never reads browser cookies or accepts passwords.";
  if (input instanceof HTMLInputElement) input.placeholder = isX ? "numeric X user ID" : "reddit native user ID";
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
    if (error.status === 401 && error.code !== "CSRF_REQUIRED") { state.signedIn = false; state.mutationReady = false; client.clearSession(); }
    state.error = { message: error.message, requestId: error.requestId };
  } else state.error = { message: "An unexpected local error occurred. Refresh and try again." };
}

function render() { root.innerHTML = renderApp(state); }
/** @param {string} region */
function show(region) { const element = root.querySelector(`[data-region="${region}"]`); element?.classList.remove("hidden"); element?.querySelector("input")?.focus(); }
/** @param {string} region */
function hide(region) { root.querySelector(`[data-region="${region}"]`)?.classList.add("hidden"); }
function routeFromLocation() { const route = location.hash.replace(/^#/u, "").split("?")[0] || "dashboard"; return ["dashboard", "accounts", "keys", "activity", "team", "settings", "setup", "signin"].includes(route) ? route : "dashboard"; }
/** @param {string} value */
function cssEscape(value) { return CSS.escape(value); }
