// @ts-check

/** @typedef {import('./client.js').SocialGitClient} SocialGitClient */
/** @typedef {{id:string, platform:'reddit'|'x', expectedNativeUserId:string, actualNativeUserId:string|null, label:string|null, status:string, connectionHealth?:string, actionRequiredReason?:string|null, healthGeneration?:number, lastVerifiedAt?:string|null, createdAt:string, updatedAt:string}} Account */
/** @typedef {{accountId:string,generation:number,status:string,connectedAt:string,revokedAt:string|null}} Connection */
/** @typedef {{id:string,sequence:number,callerId:string|null,accountId:string|null,type:string,outcome:string,data:unknown,occurredAt:string}} AuditEvent */
/** @typedef {{operation:string,summary?:string,mode?:string,productionEnabled?:boolean,disabledReason?:string,disabledReasons?:string[]}} CapabilityDetail */
/** @typedef {{platform:string,capabilities:string[],unsupportedCapabilities:Record<string,string>,details:CapabilityDetail[],source:'account'|'platform',error?:string}} AccountCapabilities */
/** @typedef {{accounts:Account[],connections:Record<string,Connection|null>,capabilities:Record<string,AccountCapabilities|null>,audit:AuditEvent[],health:{ready:boolean,contractVersion?:number|null,checks:Record<string,unknown>}}} Overview */
/** @typedef {{route:string,signedIn:boolean,mutationReady:boolean,busy:boolean,error:null|{message:string,requestId?:string|null},notice:string|null,overview:Overview|null,keys:null|{items:Array<{id:string,name:string,prefix:string,scopes:string[],createdAt:string,lastUsedAt:string|null}>},keysUnavailable:boolean,backups:null|{items:Array<{id:string,status:string,createdAt:string,expiresAt:string,completedAt:string|null,sizeBytes:number|null,databaseCount:3,errorCode?:string}>},upgrade:null|{currentVersion:string,latestVersion:null,updateAvailable:false,channel:string,automation?:string,message?:string},settingsUnavailable:boolean,action:unknown,jobs:null|{items:Array<Record<string,unknown>>,nextCursor:string|null},usage:null|{items:Array<Record<string,unknown>>,retentionDays:number},session:null|{workspaceId:string,role:string},workspaces:null|{items:Array<{id:string,name:string,role:string}>},members:null|{items:Array<{userId:string,email:string,displayName:string,role:string,status:string}>},invitation:null|{token?:string,revealed?:boolean},createdSecret:null|{value:string,revealed:boolean},admission:unknown,admissionPrepared:unknown,admissionEvidence:unknown,admissionUnavailable:boolean}} ViewState */

const routes = [
  ["dashboard", "Overview"],
  ["accounts", "Accounts"],
  ["keys", "API keys"],
  ["activity", "Activity & jobs"],
  ["team", "Team"],
  ["admission", "Release proofs"],
  ["settings", "Settings"],
];

/** @param {ViewState} state */
export function renderApp(state) {
  if (state.route === "setup") return renderSetup(state);
  if (state.route === "signin" || !state.signedIn) return renderSignIn(state);
  const page = pageFor(state);
  return `<div class="app-shell">
    <aside class="sidebar" aria-label="Primary">
      <a class="brand" href="#dashboard" aria-label="Social Git home"><span class="brand-mark" aria-hidden="true">S</span><span><strong>Social Git</strong><small>Control plane</small></span></a>
      <nav>${routes.map(([route, label]) => `<a href="#${route}" ${state.route === route ? 'aria-current="page"' : ""}><span class="nav-dot" aria-hidden="true"></span>${label}</a>`).join("")}</nav>
      <div class="sidebar-foot"><span class="status-dot ${state.overview?.health.ready ? "good" : "warn"}" aria-hidden="true"></span><span>${state.overview?.health.ready ? "System operational" : "Check system health"}</span></div>
    </aside>
    <div class="workspace">
      <header class="topbar"><button class="mobile-menu" type="button" data-action="toggle-menu" aria-label="Open navigation" aria-expanded="false">☰</button><div><span class="eyebrow">SELF-HOSTED WORKSPACE</span><strong>${escapeHtml(titleFor(state.route))}</strong></div><div class="top-actions"><a class="icon-button" href="/docs/" aria-label="Open interactive API explorer">API</a><button class="avatar" type="button" data-action="signout" title="Sign out">SG</button></div></header>
      <main id="main" class="content" tabindex="-1">${reauthenticationBanner(state)}${banner(state)}${page}</main>
    </div>
  </div>`;
}

/** @param {ViewState} state */
function pageFor(state) {
  switch (state.route) {
    case "accounts": return renderAccounts(state);
    case "keys": return renderKeys(state);
    case "activity": return renderActivity(state);
    case "team": return renderTeam(state);
    case "admission": return renderAdmission(state);
    case "settings": return renderSettings(state);
    default: return renderDashboard(state);
  }
}

/** @param {ViewState} state */
function renderAdmission(state) {
  if (state.session?.role !== "owner") return `<div class="banner warning"><div><strong>Owner access required</strong><p>Release-proof requests are installation-owner controlled.</p></div></div>`;
  if (state.admissionUnavailable) return unavailable("Release certification is fail-closed", "No dual-signed v2 envelope with committed release-maintainer trust roots is installed. Local UI state or environment variables cannot enable it.");
  const prepared = record(state.admissionPrepared);
  const proof = record(prepared.proof);
  const admission = record(state.admission);
  const approval = record(admission.approval);
  const binding = record(admission.binding);
  const release = record(admission.release);
  const active = admission.active === true;
  const mutationEnabled = state.mutationReady && active;
  const accounts = state.overview?.accounts ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">RELEASE CERTIFICATION</span><h1>Bounded live proofs</h1><p>Prepare an owner request, have independent QA sign its exact canonical digest offline, then consume it once. This page cannot sign approvals or enable product capabilities.</p></div></section>
    <div class="banner warning"><div><strong>Separate trust domains</strong><p>Installation owner, independent QA, security approver, and release maintainer remain distinct. X product access stays disabled until a later reviewed source commit closes every gate.</p></div></div>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">SIGNED WINDOW</span><h2>${active ? "Currently active" : "Configured but inactive"}</h2></div><span class="pill ${active ? "success" : "warning"}">${active ? "active" : "inactive"}</span></div><p>Platform: <strong>${escapeHtml(String(binding.platform ?? "unknown"))}</strong> · valid ${escapeHtml(String(approval.notBefore ?? "unknown"))} to ${escapeHtml(String(approval.expiresAt ?? "unknown"))} · action limit ${escapeHtml(String(approval.actionLimit ?? "unknown"))}</p><p class="field-help">Account ${escapeHtml(String(binding.accountIdDigest ?? ""))} · route ${escapeHtml(String(binding.routeIdDigest ?? ""))} · generation ${escapeHtml(String(binding.sessionGeneration ?? ""))} · deployment ${escapeHtml(String(release.deploymentId ?? ""))}</p>${active ? "" : `<div class="banner warning"><div><strong>Execution disabled</strong><p>The independently signed validity window is not active. Normal product readiness remains separate.</p></div></div>`}</section>
    <section class="split-grid"><div class="panel"><div class="panel-head"><div><span class="eyebrow">1 · PREPARE</span><h2>Request exact proof</h2></div></div><form class="stack-form" data-form="admission-prepare"><label>Account <select name="accountId" required>${accounts.map((account) => `<option value="${escapeAttr(account.id)}">${escapeHtml(account.label ?? account.id)} · ${escapeHtml(account.platform)}</option>`).join("")}</select></label><label>Proof <select name="proofKind"><option value="identity">Identity</option><option value="read">Read target</option><option value="canary_write">Canary write</option><option value="canary_cleanup">Canary cleanup</option></select></label><label>Target native ID <input name="targetId" maxlength="128"></label><label>Parent proof ID (cleanup only) <input name="parentProofId" maxlength="36"></label><label>TTL seconds <input name="expiresInSeconds" type="number" min="60" max="900" value="300"></label><label>Exact prepare confirmation <input name="confirmation" required maxlength="300" placeholder="PREPARE reddit identity account-id"></label><button class="button primary" ${mutationEnabled ? "" : "disabled"}>Prepare proof</button></form></div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">2 · INDEPENDENT QA</span><h2>Inspect, recompute, sign</h2></div></div>${proof.id ? `<p class="field-help">Export and inspect the complete redacted canonical request. QA recomputes its SHA-256 digest before signing the challenge outside Social Git.</p><pre>${escapeHtml(JSON.stringify(prepared.proofRequest ?? {}, null, 2))}</pre><p><strong>Digest</strong></p><code>${escapeHtml(String(prepared.proofRequestDigest ?? ""))}</code><p><strong>Challenge</strong></p><code>${escapeHtml(String(prepared.qaExecutionChallenge ?? ""))}</code><form class="stack-form" data-form="admission-execute"><label>Exact execution confirmation <input name="confirmation" required value="${escapeAttr(String(prepared.requiredExecutionConfirmation ?? ""))}"></label><label>Detached QA Ed25519 signature <input name="qaExecutionSignature" required maxlength="86" autocomplete="off"></label><button class="button primary" ${mutationEnabled ? "" : "disabled"}>Consume authorization once</button></form>` : `<div class="empty compact-empty"><h3>No prepared proof</h3><p>Preparing does not contact a provider.</p></div>`}</div></section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">3 · VERIFY</span><h2>Portable redacted evidence</h2></div></div><form class="stack-form" data-form="admission-evidence"><label>Terminal proof ID <input name="proofId" required maxlength="36"></label><button class="button subtle">Load signed evidence</button></form>${state.admissionEvidence ? `<pre>${escapeHtml(JSON.stringify(state.admissionEvidence, null, 2))}</pre>` : ""}</section>`;
}

/** @param {ViewState} state */
function renderTeam(state) {
  const workspaces = state.workspaces?.items ?? [];
  const workspace = workspaces.find((item) => item.id === state.session?.workspaceId) ?? workspaces[0];
  const members = state.members?.items ?? [];
  const owner = state.session?.role === "owner";
  return `<section class="page-head compact"><div><span class="eyebrow">LOCAL ACCESS</span><h1>Team & access</h1><p>Manage local users and roles without a hosted identity provider or outbound email.</p></div></section>
    <section class="panel"><div class="panel-head"><div><span class="eyebrow">PRIMARY DATA WORKSPACE</span><h2>${escapeHtml(workspace?.name ?? "Default workspace")}</h2></div><span class="pill">${escapeHtml(state.session?.role ?? "unknown")}</span></div>
      <p class="field-help">This self-hosted installation has one data workspace shared by its authorized local users. Accounts, encrypted sessions, actions, usage, webhooks, audit history, and backups remain in this boundary.</p>
    </section>
    ${owner ? `<section class="split-grid"><div class="panel"><div class="panel-head"><div><span class="eyebrow">DIRECT PROVISIONING</span><h2>Create local member</h2></div></div><form class="stack-form" data-form="member"><label>Name <input name="displayName" required maxlength="120"></label><label>Email <input name="email" type="email" required maxlength="254"></label><label>Temporary password <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label><label>Role <select name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select></label><button class="button primary" ${state.mutationReady ? "" : "disabled"}>Create member</button></form></div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">ONE-TIME INVITATION</span><h2>Create invitation</h2></div></div><p class="field-help">No email is sent. Share the token over a trusted channel; it is stored only as a hash and can be consumed once.</p><form class="stack-form" data-form="invitation"><label>Email <input name="email" type="email" required maxlength="254"></label><label>Role <select name="role"><option value="member">Member</option><option value="admin">Admin</option><option value="owner">Owner</option></select></label><button class="button primary" ${state.mutationReady ? "" : "disabled"}>Create invitation</button></form>${invitationPanel(state)}</div></section>` : `<div class="banner warning"><div><strong>Member access</strong><p>Only workspace owners can provision users, create invitations, or change memberships.</p></div></div>`}
    <section class="panel table-panel"><div class="panel-head"><div><span class="eyebrow">MEMBERSHIPS</span><h2>Workspace members</h2></div></div>${members.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${members.map((member) => `<tr><td><strong>${escapeHtml(member.displayName)}</strong><small>${escapeHtml(member.email)}</small></td><td>${escapeHtml(member.role)}</td><td>${statusPill(member.status)}</td><td>${owner && member.status === "active" ? `<button class="text-danger" data-action="deactivate-member" data-id="${escapeAttr(member.userId)}">Deactivate</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty compact-empty"><h3>No members</h3></div>`}</section>`;
}

/** @param {ViewState} state */
function invitationPanel(state) {
  const token = state.invitation?.token;
  if (!token) return "";
  const revealed = state.invitation?.revealed === true;
  return `<div class="hint"><strong>Copy once</strong>${revealed ? `<code>${escapeHtml(token)}</code>` : `<code aria-label="Masked invitation token">••••••••••••••••</code>`}`
    + `<div class="card-actions"><button class="button subtle" type="button" data-action="${revealed ? "hide-invitation" : "reveal-invitation"}">${revealed ? "Hide" : "Reveal"}</button>`
    + `<button class="button subtle" type="button" data-action="copy-invitation">Copy</button>`
    + `<button class="button ghost" type="button" data-action="dismiss-invitation">Dismiss</button></div></div>`;
}

/** @param {ViewState} state */
function renderDashboard(state) {
  const overview = state.overview;
  const accounts = overview?.accounts ?? [];
  const active = accounts.filter((account) => accountOperational(account, overview?.connections[account.id] ?? null, overview?.capabilities?.[account.id] ?? null)).length;
  const attention = Math.max(0, accounts.length - active);
  return `<section class="page-head"><div><span class="eyebrow">OPERATIONS AT A GLANCE</span><h1>Good ${dayPart()}.</h1><p>Manage account sessions, API access, and every social action from one private workspace.</p></div><a class="button primary" href="#accounts">Add an account <span aria-hidden="true">→</span></a></section>
    <section class="metrics" aria-label="Workspace summary">
      ${metric("Connected accounts", String(active), active ? "Healthy sessions" : "Connect your first account", active > 0)}
      ${metric("Needs attention", String(attention), attention ? "Review account health" : "Nothing blocked", attention === 0)}
      ${metric("Core status", overview?.health.ready ? "Ready" : "Unavailable", overview?.health.ready ? "API and workers responding" : "Inspect readiness checks", Boolean(overview?.health.ready))}
    </section>
    <section class="split-grid">
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">ACCOUNTS</span><h2>Connection health</h2></div><a href="#accounts">View all</a></div>${accountRows(accounts.slice(0, 4), overview?.connections ?? {}, overview?.capabilities ?? {})}</div>
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">RECENT</span><h2>Workspace activity</h2></div><a href="#activity">View log</a></div>${activityRows(overview?.audit.slice(0, 5) ?? [])}</div>
    </section>
    ${systemDiagnostics(overview?.health)}
    <section class="callout"><div class="callout-icon" aria-hidden="true">↗</div><div><h2>Build against one stable API</h2><p>Use the local interactive OpenAPI explorer or MCP endpoint. Platform sessions never enter browser storage.</p></div><a class="button subtle" href="/docs/">Explore API</a></section>
    ${apiExamples(accounts)}`;
}

/** @param {Overview['health']|undefined} health */
function systemDiagnostics(health) {
  const checks = record(health?.checks);
  const databases = record(checks.databases);
  const workers = record(checks.workers);
  const maintenance = record(checks.maintenance);
  const backlog = record(checks.backlog);
  if (!Object.keys(databases).length && !Object.keys(workers).length) return "";
  const actionDb = record(databases.actions);
  const sessionDb = record(databases.sessions);
  const identityDb = record(databases.identity);
  const actionWorker = record(workers.action);
  const webhookWorker = record(workers.webhook);
  const redditWorker = record(workers.reddit);
  const xWorker = record(workers.x);
  const actionBacklog = record(backlog.actions);
  const webhookBacklog = record(backlog.webhooks);
  const xDisabledReasons = Array.isArray(xWorker.disabledReasons)
    ? xWorker.disabledReasons.filter((reason) => typeof reason === "string").slice(0, 8)
    : [];
  /** @param {string} label @param {string} state @param {boolean} good @param {string} detail */
  const component = (label, state, good, detail) => `<article class="diagnostic-card"><div><span>${escapeHtml(label)}</span>${statusPill(state)}</div><p><i class="status-dot ${good ? "good" : "warn"}"></i>${escapeHtml(detail)}</p></article>`;
  const dbSummary = [actionDb, sessionDb, identityDb].every((item) => item.ready === true);
  const maintenanceIdle = maintenance.state !== "active";
  return `<section class="panel diagnostics-panel" aria-labelledby="diagnostics-title"><div class="panel-head"><div><span class="eyebrow">NON-SECRET DIAGNOSTICS</span><h2 id="diagnostics-title">Runtime readiness</h2></div><code>contract v${escapeHtml(health?.contractVersion ?? 1)}</code></div>
    <div class="diagnostic-grid">
      ${component("Databases & migrations", dbSummary ? "ready" : "not ready", dbSummary, databaseSummary(actionDb, sessionDb, identityDb))}
      ${component("Reddit worker", String(redditWorker.state ?? "unknown"), redditWorker.state === "reachable" || redditWorker.state === "fixture_embedded", `Required: ${redditWorker.required === true ? "yes" : "no"}`)}
      ${component("X worker", String(xWorker.state ?? "unknown"), xWorker.state === "reachable" || xWorker.state === "fixture_embedded", `Admission: ${humanize(String(xWorker.admission ?? "unknown"))}`)}
      ${component("Background workers", actionWorker.ready === true && webhookWorker.ready === true ? "ready" : "not ready", actionWorker.ready === true && webhookWorker.ready === true, `Actions ${String(actionWorker.state ?? "unknown")} · webhooks ${String(webhookWorker.state ?? "unknown")}`)}
      ${component("Backup maintenance", maintenanceIdle ? "idle" : "active", maintenanceIdle, maintenanceIdle ? "Normal request admission" : "Writers paused; retry after backup")}
      ${component("Bounded backlog", "reported", true, `Actions q/r/u ${countValue(actionBacklog.queued)}/${countValue(actionBacklog.running)}/${countValue(actionBacklog.unknown)} · webhooks p/e ${countValue(webhookBacklog.pending)}/${countValue(webhookBacklog.exhausted)}`)}
    </div>${xWorker.productionEnabled === false ? `<div class="diagnostic-note"><strong>X capability disabled</strong><p>Worker reachability is deployment health, not production admission.</p>${xDisabledReasons.length ? `<ul>${xDisabledReasons.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("")}</ul>` : ""}</div>` : ""}</section>`;
}

/** @param {Record<string,unknown>} actions @param {Record<string,unknown>} sessions @param {Record<string,unknown>} identity */
function databaseSummary(actions, sessions, identity) {
  /** @param {Record<string,unknown>} value */
  const version = (value) => { const migration = record(value.migration); return `${migration.current ?? "?"}/${migration.expected ?? "?"}`; };
  return `actions ${version(actions)} · sessions ${version(sessions)} · identity ${version(identity)}`;
}

/** @param {unknown} value */
function countValue(value) {
  const item = record(value);
  return `${item.value ?? 0}${item.truncated === true ? "+" : ""}`;
}

/** @param {unknown} value @returns {Record<string,unknown>} */
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string,unknown>} */ (value) : {}; }

/** @param {ViewState} state */
function renderAccounts(state) {
  const accounts = state.overview?.accounts ?? [];
  const reddit = accounts.filter((account) => account.platform === "reddit").length;
  const x = accounts.filter((account) => account.platform === "x").length;
  const connected = accounts.filter((account) => state.overview?.connections[account.id]?.status === "active").length;
  return `<section class="page-head compact"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h1>Social accounts</h1><p>Register a platform identity, inspect its admitted capabilities, and manage its Core-custodied session generation.</p><div class="health-summary" aria-label="Multi-account health"><span>${accounts.length} registered</span><span>${connected} connected</span><span>${reddit} Reddit</span><span>${x} X</span></div></div><button class="button primary" type="button" data-action="show-account-form" ${state.mutationReady ? "" : 'disabled title="Confirm your password to make changes"'}>Add account</button></section>
    <section class="panel form-panel hidden" data-region="account-form"><div class="panel-head"><div><span class="eyebrow">NEW ACCOUNT</span><h2>Register a social identity</h2></div></div>
      <form data-form="account" class="form-grid"><label>Platform <select name="platform" data-field="platform" aria-describedby="platform-guidance"><option value="reddit">Reddit</option><option value="x">X (encrypted custody only)</option></select></label><label>Label <input name="label" maxlength="120" placeholder="Community account"></label><label><span data-platform-identity-label>Expected Reddit native user ID</span><input name="expectedNativeUserId" required maxlength="128" autocomplete="off" placeholder="reddit native user ID" aria-describedby="native-identity-help"></label><p class="field-help" id="native-identity-help" data-platform-identity-help>Use the immutable native ID returned by Reddit, not a display name or email.</p><div class="platform-guidance" id="platform-guidance"><strong data-platform-guidance-title>Reddit connects from one explicitly exported session file.</strong><span data-platform-guidance-detail>Upload the documented JSON export. Social Git does not read browser cookies, accept Reddit passwords, or use browser automation.</span></div><div class="form-actions"><button class="button primary" ${state.busy || !state.mutationReady ? "disabled" : ""}>Register account</button><button class="button ghost" type="button" data-action="hide-account-form">Cancel</button></div></form>
    </section>
    <section class="cards">${accounts.length ? accounts.map((account) => accountCard(account, state.overview?.connections[account.id] ?? null, state.overview?.capabilities?.[account.id] ?? null, state.mutationReady)).join("") : emptyState("No accounts yet", "Register a Reddit identity for admitted use, or an X identity for inventory while X production admission remains disabled.", "Add account", "show-account-form")}</section>`;
}

/** @param {ViewState} state */
function renderKeys(state) {
  const keys = state.keys?.items ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">PROGRAMMATIC ACCESS</span><h1>API keys</h1><p>Create least-privilege credentials for your apps and automations.</p></div><button class="button primary" type="button" data-action="show-key-form" ${state.keysUnavailable || !state.mutationReady ? "disabled" : ""}>Create key</button></section>
    ${oneTimeSecretPanel(state)}${state.keysUnavailable ? unavailable("API key management is waiting for the API key service", "This server build does not expose API-key management yet. Owner cookie authentication is active.") : `<section class="panel form-panel hidden" data-region="key-form"><form data-form="key" class="form-grid"><label>Key name <input name="name" maxlength="80" required placeholder="Production automation"></label><fieldset><legend>Scopes</legend><label class="check"><input type="checkbox" name="scopes" value="accounts:read" checked> Read accounts</label><label class="check"><input type="checkbox" name="scopes" value="accounts:write"> Register accounts</label><label class="check"><input type="checkbox" name="scopes" value="connections:read"> Read connection health</label><label class="check"><input type="checkbox" name="scopes" value="connections:write"> Connect and revoke sessions</label><label class="check"><input type="checkbox" name="scopes" value="social:read" checked> Read social data</label><label class="check"><input type="checkbox" name="scopes" value="social:write"> Create social actions</label><label class="check"><input type="checkbox" name="scopes" value="actions:read"> Read action status</label><label class="check"><input type="checkbox" name="scopes" value="audit:read"> Read audit log</label><label class="check"><input type="checkbox" name="scopes" value="webhooks:read"> Read webhook delivery state</label><label class="check"><input type="checkbox" name="scopes" value="webhooks:write"> Manage webhook subscriptions</label><label class="check"><input type="checkbox" name="scopes" value="usage:read"> Read redacted usage aggregates</label></fieldset><div class="form-actions"><button class="button primary" ${state.mutationReady ? "" : "disabled"}>Create key</button><button class="button ghost" type="button" data-action="hide-key-form">Cancel</button></div></form></section>
    <section class="panel table-panel">${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Token</th><th>Scopes</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${keys.map((key) => `<tr><td><strong>${escapeHtml(key.name)}</strong><small>${formatDate(key.createdAt)}</small></td><td><code>${escapeHtml(key.prefix)}••••••••</code></td><td>${escapeHtml(key.scopes.join(", "))}</td><td>${key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</td><td><button class="text-danger" data-action="revoke-key" data-id="${escapeAttr(key.id)}">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("No API keys", "Create a scoped key for an application or automation. The secret is shown only once.", "Create key", "show-key-form")}</section>`}`;
}

/** @param {ViewState} state */
function oneTimeSecretPanel(state) {
  const secret = state.createdSecret;
  if (!secret?.value) return "";
  const revealed = secret.revealed === true;
  return `<section class="panel" aria-label="One-time API secret"><div class="panel-head"><div><span class="eyebrow">ONE-TIME SECRET</span><h2>Copy once, then it disappears</h2></div><span class="pill warning">masked by default</span></div>`
    + `<p class="field-help">The secret is shown only once. It is masked until you explicitly reveal it, and it is cleared when you dismiss it, navigate, or sign out.</p>`
    + `<div class="hint"><strong>Copy once</strong>${revealed ? `<code>${escapeHtml(secret.value)}</code>` : `<code aria-label="Masked one-time secret">••••••••••••••••</code>`}</div>`
    + `<div class="card-actions"><button class="button subtle" type="button" data-action="${revealed ? "hide-secret" : "reveal-secret"}">${revealed ? "Hide" : "Reveal"}</button>`
    + `<button class="button subtle" type="button" data-action="copy-secret">Copy</button>`
    + `<button class="button ghost" type="button" data-action="dismiss-secret">Dismiss</button></div></section>`;
}

/** @param {ViewState} state */
function renderActivity(state) {
  const events = state.overview?.audit ?? [];
  const jobs = state.jobs?.items ?? [];
  const usage = state.usage?.items ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">TRACE EVERY CHANGE</span><h1>Activity & jobs</h1><p>Review the tenant queue, safely cancel only unclaimed work, and inspect redacted usage.</p></div><button class="icon-button" type="button" data-action="refresh" aria-label="Refresh activity">↻</button></section>
    <section class="panel queue-panel" aria-labelledby="queue-title"><div class="panel-head"><div><span class="eyebrow">DURABLE QUEUE</span><h2 id="queue-title">Actions</h2></div><a href="/openapi.json" target="_blank" rel="noreferrer">Filters & cursors</a></div>${queueRows(jobs, state.mutationReady)}${state.jobs?.nextCursor ? `<p class="queue-note">More actions are available through the opaque <code>cursor</code> in the REST or MCP interface.</p>` : ""}</section>
    <section class="split-grid activity-layout"><div class="panel"><div class="panel-head"><div><span class="eyebrow">AUDIT TRAIL</span><h2>Recent events</h2></div></div>${activityRows(events)}</div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">JOB LOOKUP</span><h2>Inspect an action</h2></div></div><form class="stack-form" data-form="action"><label>Action ID <input name="actionId" required maxlength="128" placeholder="action_…"></label><button class="button primary">Look up job</button></form>${state.action ? renderAction(state.action, state.mutationReady) : `<div class="hint"><strong>Durable by design</strong><p>Every write has a caller-scoped idempotency key and an inspectable lifecycle. UNKNOWN actions are never submitted again automatically.</p><code>GET /v1/actions/&lt;ACTION_ID&gt;</code></div>`}</div></section>
    <section class="panel usage-panel" aria-labelledby="usage-title"><div class="panel-head"><div><span class="eyebrow">REDACTED USAGE</span><h2 id="usage-title">Operations by account</h2></div><span class="pill">${state.usage?.retentionDays ?? 90}-day retention</span></div>${usageRows(usage)}</section>`;
}

/** @param {Array<Record<string,unknown>>} jobs @param {boolean} mutationReady */
function queueRows(jobs, mutationReady) {
  if (!jobs.length) return `<div class="empty compact-empty"><h3>No actions yet</h3><p>Queued and terminal write actions will appear here without their request payloads.</p></div>`;
  return `<div class="queue-list">${jobs.map((job) => {
    const state = typeof job.state === "string" ? job.state : "unknown";
    const unknown = state === "UNKNOWN" || job.submissionMayHaveStarted === true;
    return `<article class="queue-row"><div><strong>${escapeHtml(typeof job.kind === "string" ? humanize(job.kind) : "Action")}</strong><small>${escapeHtml(typeof job.id === "string" ? job.id : "Unknown")} · ${escapeHtml(typeof job.accountId === "string" ? job.accountId : "Unknown account")}</small>${unknown ? `<span class="queue-warning">Do not resubmit — the platform result may be ambiguous.${state === "UNKNOWN" ? " Reconcile verifies only." : ""}</span>` : ""}</div><div class="queue-actions">${statusPill(state)}${state === "queued" ? `<button class="text-danger" type="button" data-action="cancel-job" data-id="${escapeAttr(job.id ?? "")}" ${mutationReady ? "" : "disabled"}>Cancel before dispatch</button>` : ""}${state === "UNKNOWN" ? `<button class="button subtle" type="button" data-action="reconcile-action" data-id="${escapeAttr(job.id ?? "")}" ${mutationReady ? "" : "disabled"}>Reconcile result</button>` : ""}</div></article>`;
  }).join("")}</div>`;
}

/** @param {Array<Record<string,unknown>>} usage */
function usageRows(usage) {
  if (!usage.length) return `<div class="empty compact-empty"><h3>No usage recorded</h3><p>Counts appear after REST or MCP operations. Payloads, cookies, tokens, and social content are never stored here.</p></div>`;
  return `<div class="usage-grid">${usage.map((item) => `<article><span>${escapeHtml(typeof item.operationId === "string" ? humanize(item.operationId) : "All operations")}</span><strong>${escapeHtml(typeof item.count === "number" ? item.count : 0)}</strong><small>${escapeHtml(item.outcome ?? "unknown")} · ${escapeHtml(item.accountId ?? "tenant-wide")}</small></article>`).join("")}</div>`;
}

/** @param {ViewState} state */
function renderSettings(state) {
  if (state.settingsUnavailable) return `<section class="page-head compact"><div><span class="eyebrow">INSTANCE OPERATIONS</span><h1>Settings</h1><p>Backups, updates, and deployment-safe instance controls.</p></div></section>${unavailable("Instance management is unavailable", "This installation did not expose the owner operations service. Use the documented offline backup command and inspect Core logs.")}`;
  const backups = state.backups?.items ?? [];
  const upgrade = state.upgrade;
  const running = backups.some((backup) => backup.status === "running");
  return `<section class="page-head compact"><div><span class="eyebrow">INSTANCE OPERATIONS</span><h1>Settings</h1><p>Backups, updates, and deployment-safe instance controls.</p></div></section>
    <section class="split-grid"><div class="panel"><div class="panel-head"><div><span class="eyebrow">BACKUPS</span><h2>Encrypted recovery sets</h2></div><div class="card-actions"><button class="icon-button" type="button" data-action="refresh" aria-label="Refresh backups">↻</button><button class="button subtle" data-action="create-backup" ${state.mutationReady && !running ? "" : "disabled"}>${running ? "Backup running…" : "Create backup"}</button></div></div><p class="field-help">Each owner-initiated set contains encrypted, tenant-bound snapshots of sessions, actions, and identity. Paths and filenames are generated by Core and are never accepted from the browser.</p>${backups.length ? backups.map((backup) => `<div class="list-row backup-row"><div><strong>${escapeHtml(backup.id)}</strong><small>Created ${formatDate(backup.createdAt)} · Expires ${formatDate(backup.expiresAt)} · ${backup.sizeBytes === null ? "size pending" : formatBytes(backup.sizeBytes)} · ${backup.databaseCount} databases${backup.errorCode ? ` · ${escapeHtml(backup.errorCode)}` : ""}</small></div>${statusPill(backup.status)}</div>`).join("") : `<div class="empty compact-empty"><h3>No backups yet</h3><p>Create a tenant-bound encrypted recovery set before a manual upgrade.</p></div>`}</div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">UPGRADES</span><h2>Manual only</h2></div><span class="pill warning">${escapeHtml(upgrade?.channel ?? "manual")}</span></div><div class="version-card"><span>Installed</span><strong>${escapeHtml(upgrade?.currentVersion ?? "Unknown")}</strong><span>Automatic upgrades and remote update checks are unavailable.</span></div><div class="hint"><strong>No remote updater</strong><p>${escapeHtml(upgrade?.message ?? "Create and export a backup, then follow the self-hosting upgrade guide from the deployed release.")}</p></div></div></section>`;
}

/** @param {ViewState} state */
function renderSignIn(state) {
  return `<main id="main" class="auth-page"><section class="auth-visual"><div class="auth-brand"><span class="brand-mark">S</span><strong>Social Git</strong></div><div class="visual-copy"><span class="eyebrow">YOUR SOCIAL INFRASTRUCTURE</span><h1>One private gateway.<br><em>Every account.</em></h1><p>Operate Reddit today and more platforms tomorrow through a stable, self-hosted interface.</p></div><div class="visual-proof"><span>HttpOnly owner session</span><span>Encrypted social sessions</span><span>Auditable actions</span></div></section><section class="auth-form"><div class="auth-card">${banner(state)}<span class="eyebrow">WELCOME BACK</span><h2>Sign in to your workspace</h2><p>Your server creates a secure, same-site owner session. Credentials and session material are never saved in browser storage.</p><form data-form="signin" class="stack-form"><label>Email <input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label><label>Password <input type="password" name="password" required maxlength="256" autocomplete="current-password" placeholder="Your owner password"></label><button class="button primary full" ${state.busy ? "disabled" : ""}>${state.busy ? "Checking…" : "Sign in"}</button></form><div class="auth-help"><span>Owner access stays on this installation.</span><a href="/openapi.json">API contract</a></div></div><footer>Private by default · Cookie protected with HttpOnly and SameSite</footer></section></main>`;
}

/** @param {ViewState} state */
function renderSetup(state) {
  return `<main id="main" class="setup-page"><header class="setup-top"><span class="brand"><span class="brand-mark">S</span><strong>Social Git</strong></span><span class="pill">Self-hosted setup</span></header><section class="setup-wrap"><div class="step-copy"><span class="step-number">01</span><span class="eyebrow">CREATE THE OWNER</span><h1>Make this workspace yours.</h1><p>The first owner controls API keys, backups, and account access. The one-time setup endpoint closes permanently after this account is created.</p><ul><li><span>✓</span> Local owner account</li><li><span>✓</span> HttpOnly browser session</li><li><span>✓</span> No hosted dependency</li></ul></div><div class="setup-card">${banner(state)}<form data-form="setup" class="stack-form"><label>Your name <input name="displayName" required minlength="1" maxlength="120" autocomplete="name" placeholder="Primary Owner"></label><label>Owner email <input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label><label>Password <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="At least 12 characters"></label><p class="field-help">Use a unique password. Configure HTTPS at your reverse proxy before adding real accounts.</p><button class="button primary full" ${state.busy ? "disabled" : ""}>${state.busy ? "Creating owner…" : "Create owner account"}</button></form></div></section></main>`;
}

/** @param {Account[]} accounts @param {Record<string,Connection|null>} connections @param {Record<string,AccountCapabilities|null>} capabilities */
function accountRows(accounts, connections, capabilities) {
  if (!accounts.length) return `<div class="empty compact-empty"><h3>No accounts connected</h3><p>Add an account to start using the API.</p><a class="inline-link" href="#accounts">Add your first account →</a></div>`;
  return `<div class="list">${accounts.map((account) => {
    const connection = connections[account.id] ?? null;
    const status = account.platform === "x" && !accountOperational(account, connection, capabilities[account.id] ?? null) ? "production disabled" : connection?.status ?? account.status;
    return `<div class="list-row"><div class="account-id">${platformLogo(account.platform)}<div><strong>${escapeHtml(account.label || account.expectedNativeUserId)}</strong><small>${escapeHtml(platformName(account.platform))} · ${escapeHtml(account.actualNativeUserId || account.expectedNativeUserId)}</small></div></div>${statusPill(status)}</div>`;
  }).join("")}</div>`;
}

/** @param {AuditEvent[]} events */
function activityRows(events) {
  if (!events.length) return `<div class="empty compact-empty"><h3>No activity yet</h3><p>Account and action events will appear here.</p></div>`;
  return `<ol class="timeline">${events.map((event) => `<li><span class="timeline-dot" aria-hidden="true"></span><div><strong>${escapeHtml(humanize(event.type))}</strong><p>${escapeHtml(event.outcome)}${event.accountId ? ` · ${escapeHtml(event.accountId)}` : ""}</p></div><time datetime="${escapeAttr(event.occurredAt)}">${relativeTime(event.occurredAt)}</time></li>`).join("")}</ol>`;
}

/** @param {Account} account @param {Connection|null} connection @param {AccountCapabilities|null} capabilities @param {boolean} mutationReady */
function accountCard(account, connection, capabilities, mutationReady) {
  const disconnected = !connection || connection.status !== "active";
  const xBlocked = account.platform === "x" && !accountOperational(account, connection, capabilities);
  const status = xBlocked ? "production disabled" : account.connectionHealth ?? connection?.status ?? account.status;
  const hasStagedGeneration = (account.healthGeneration ?? 0) > 0;
  const connectionMode = connection || hasStagedGeneration ? "refresh" : "import";
  const connectLabel = connection ? (connection.status === "active" ? "Refresh session" : "Reconnect") : hasStagedGeneration ? "Replace staged session" : "Connect session";
  const controls = account.platform === "x"
    ? `<button class="button subtle" data-action="show-connect" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>${connectLabel}</button><span class="blocked-control" title="X production connection is not admitted">Execution unavailable</span>${connection?.status === "active" ? `<button class="button ghost" data-action="revoke-account" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Revoke fixture session</button>` : ""}`
    : `<button class="button subtle" data-action="show-connect" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>${connectLabel}</button>${connection?.status === "active" ? `<button class="button ghost" data-action="revoke-account" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Revoke</button>` : ""}`;
  const connectForm = account.platform === "reddit"
    ? `<form class="inline-connect hidden" data-form="connect" data-platform="reddit" data-mode="${connectionMode}" data-account-id="${escapeAttr(account.id)}"><div class="session-guidance"><strong>Upload an explicitly exported owner session.</strong><p>The file must contain only the documented Reddit cookie, fresh Reddit CSRF value, and expected native identity. Social Git does not read browser cookies, accept Reddit passwords, or store plaintext uploads.</p></div><label>Reddit session export <input name="sessionFile" type="file" required accept="application/json,.json" aria-describedby="session-help-${escapeAttr(account.id)}"></label><small id="session-help-${escapeAttr(account.id)}">JSON only, 24 KiB maximum. It is encrypted directly into Core custody after identity validation.</small><button class="button primary" ${mutationReady ? "" : "disabled"}>${connectionMode === "refresh" ? "Replace and verify" : "Import and verify"}</button></form>`
    : `<form class="inline-connect hidden" data-form="connect" data-platform="x" data-mode="${connectionMode}" data-account-id="${escapeAttr(account.id)}"><div class="session-guidance"><strong>Stage an explicitly exported owner session.</strong><p>The JSON must contain only platform, expectedNativeUserId, auth_token, and ct0. Social Git does not read browser cookies, accept X passwords, or store plaintext uploads.</p></div><label>X session export <input name="sessionFile" type="file" required accept="application/json,.json" aria-describedby="session-help-${escapeAttr(account.id)}"></label><small id="session-help-${escapeAttr(account.id)}">JSON only, 24 KiB maximum. Core encrypts it immediately. Until X transport admission, no identity request runs and this account remains action_required.</small><button class="button primary" ${mutationReady ? "" : "disabled"}>${connectionMode === "refresh" ? "Replace staged session" : "Stage encrypted session"}</button></form>`;
  return `<article class="account-card ${xBlocked ? "account-card-blocked" : ""}"><div class="account-card-top">${platformLogo(account.platform, true)}${statusPill(status)}</div><h2>${escapeHtml(account.label || account.expectedNativeUserId)}</h2><p><span class="sr-only">${escapeHtml(platformName(account.platform))} native identity:</span>${escapeHtml(account.actualNativeUserId || account.expectedNativeUserId)}</p><dl><div><dt>Platform</dt><dd>${escapeHtml(platformName(account.platform))}</dd></div><div><dt>Session generation</dt><dd>${connection?.generation ?? account.healthGeneration ?? "Not connected"}</dd></div><div><dt>Connection health</dt><dd>${escapeHtml(account.connectionHealth ?? status)}</dd></div>${account.actionRequiredReason ? `<div><dt>Action required</dt><dd><code>${escapeHtml(account.actionRequiredReason)}</code></dd></div>` : ""}<div><dt>Last verified</dt><dd>${account.lastVerifiedAt ? formatDate(account.lastVerifiedAt) : "Not yet"}</dd></div><div><dt>Updated</dt><dd>${formatDate(account.updatedAt)}</dd></div></dl>${capabilityPanel(account, capabilities)}<div class="card-actions">${controls}</div>${connectForm}<details class="api-example"><summary>API example</summary><pre>${escapeHtml(capabilityCurl(account.id))}</pre></details></article>`;
}

/** @param {Account} account @param {AccountCapabilities|null} capabilities */
function capabilityPanel(account, capabilities) {
  if (account.platform === "x") {
    const reasons = admissionReasons(capabilities);
    return `<section class="capability-panel blocked" aria-label="X production admission"><strong>Registration only · production disabled</strong><p>Connection, reads, and actions are blocked. Synthetic fixture coverage is not production support.</p><ul>${reasons.map((reason) => `<li><code>${escapeHtml(reason)}</code></li>`).join("") || "<li><code>PRODUCTION_NOT_ADMITTED</code></li>"}</ul></section>`;
  }
  if (!capabilities) return `<section class="capability-panel pending" aria-label="Reddit capability status"><strong>Connect to discover capabilities</strong><p>Capability checks run only after Core verifies the staged session belongs to this identity.</p></section>`;
  const available = capabilities.capabilities ?? [];
  const unsupported = Object.entries(capabilities.unsupportedCapabilities ?? {});
  return `<details class="capability-panel"><summary>${available.length} admitted ${available.length === 1 ? "capability" : "capabilities"}</summary><ul class="capability-list">${available.map((name) => `<li>${escapeHtml(name)}</li>`).join("") || "<li>None currently admitted</li>"}</ul>${unsupported.length ? `<strong>Explicitly unsupported</strong><ul>${unsupported.map(([name, reason]) => `<li>${escapeHtml(name)} · <code>${escapeHtml(reason)}</code></li>`).join("")}</ul>` : ""}${capabilities.error ? `<p>Latest discovery stopped with <code>${escapeHtml(capabilities.error)}</code>.</p>` : ""}</details>`;
}

/** @param {Account} account @param {Connection|null} connection @param {AccountCapabilities|null} capabilities */
function accountOperational(account, connection, capabilities) {
  if (connection?.status !== "active") return false;
  if (account.platform === "reddit") return !capabilities?.error;
  return Boolean(capabilities?.details.some((detail) => detail.productionEnabled === true));
}

/** @param {AccountCapabilities|null} capabilities */
function admissionReasons(capabilities) {
  const reasons = [];
  for (const detail of capabilities?.details ?? []) {
    if (detail.productionEnabled === true) continue;
    if (Array.isArray(detail.disabledReasons)) reasons.push(...detail.disabledReasons);
    else if (detail.disabledReason) reasons.push(detail.disabledReason);
  }
  for (const value of Object.values(capabilities?.unsupportedCapabilities ?? {})) reasons.push(...String(value).split(","));
  return [...new Set(reasons.filter((reason) => /^[A-Z][A-Z0-9_:.-]{2,127}$/u.test(reason)))];
}

/** @param {'reddit'|'x'} platform @param {boolean} [large] */
function platformLogo(platform, large = false) {
  return `<span class="platform-logo ${platform === "x" ? "x" : "reddit"} ${large ? "large" : ""}" aria-hidden="true">${platform === "x" ? "X" : "r/"}</span>`;
}

/** @param {'reddit'|'x'} platform */
function platformName(platform) { return platform === "x" ? "X" : "Reddit"; }

/** @param {string} accountId */
function capabilityCurl(accountId) { return `curl -H "Authorization: Bearer <API_KEY>" \\\n  http://localhost:8080/v1/accounts/${accountId}/capabilities`; }

/** @param {Account[]} accounts */
function apiExamples(accounts) {
  const exampleId = accounts[0]?.id ?? "<ACCOUNT_ID>";
  return `<section class="panel examples-panel" aria-labelledby="api-examples-title"><div class="panel-head"><div><span class="eyebrow">COPY-SAFE REQUESTS</span><h2 id="api-examples-title">API examples</h2></div><a href="/docs/">Interactive explorer</a></div><div class="example-grid"><div><strong>Inspect admission and capabilities</strong><pre>${escapeHtml(capabilityCurl(exampleId))}</pre></div><div><strong>Inspect a durable job</strong><pre>${escapeHtml(`curl -H "Authorization: Bearer <API_KEY>" \\\n  http://localhost:8080/v1/actions/<ACTION_ID>`)}</pre></div></div><p class="example-note">Use a scoped API key. Never put social cookies, session JSON, or the owner browser cookie in these requests. X write examples are intentionally omitted while production admission is disabled.</p></section>`;
}

/** @param {unknown} value @param {boolean} [mutationReady] */
function renderAction(value, mutationReady = false) {
  if (!isRecord(value)) return `<div class="hint"><strong>Invalid action response</strong><p>The response could not be displayed safely.</p></div>`;
  const state = typeof value.state === "string" ? value.state : "unknown";
  const id = typeof value.id === "string" ? value.id : "Unknown";
  const kind = typeof value.kind === "string" ? value.kind : "Unknown";
  const accountId = typeof value.accountId === "string" ? value.accountId : "Unknown";
  const updatedAt = typeof value.updatedAt === "string" ? formatDate(value.updatedAt) : "Unknown";
  const ambiguous = value.submissionMayHaveStarted === true || state === "UNKNOWN";
  const reconcilable = state === "UNKNOWN";
  return `<section class="job-card" aria-label="Action status"><div class="job-head"><div><span class="eyebrow">ACTION ${escapeHtml(id)}</span><h3>${escapeHtml(humanize(kind))}</h3></div>${statusPill(state)}</div><dl><div><dt>Account</dt><dd>${escapeHtml(accountId)}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(updatedAt)}</dd></div><div><dt>Idempotency</dt><dd>${escapeHtml(typeof value.idempotencyKey === "string" ? value.idempotencyKey : "Unknown")}</dd></div></dl>${ambiguous ? `<div class="unknown-warning"><strong>Do not resubmit</strong><p>The platform may have received this action. Social Git will not retry it automatically.</p></div>` : ""}${reconcilable ? `<div class="reconcile-panel"><p class="field-help">Reconcile asks the platform whether this action actually landed. It verifies only — it never resubmits or retries the write.</p><button class="button subtle" type="button" data-action="reconcile-action" data-id="${escapeAttr(id)}" ${mutationReady ? "" : "disabled"}>Reconcile result</button></div>` : ""}${value.result !== null && value.result !== undefined ? `<details><summary>Normalized result</summary><pre>${escapeHtml(JSON.stringify(value.result, null, 2))}</pre></details>` : ""}${value.error !== null && value.error !== undefined ? `<details><summary>Normalized error</summary><pre>${escapeHtml(JSON.stringify(value.error, null, 2))}</pre></details>` : ""}</section>`;
}

/** @param {string} label @param {string} value @param {string} detail @param {boolean} good */
function metric(label, value, detail, good) { return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small><i class="status-dot ${good ? "good" : "warn"}"></i>${escapeHtml(detail)}</small></article>`; }

/** @param {string} status */
function statusPill(status) { const good = status === "active" || status === "ready" || status === "succeeded"; return `<span class="pill ${good ? "success" : status === "revoked" || status === "cancelled" || status === "failed" ? "danger" : "warning"}"><i></i>${escapeHtml(humanize(status))}</span>`; }

/** @param {string} title @param {string} description @param {string} actionLabel @param {string} action */
function emptyState(title, description, actionLabel, action) { return `<div class="empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><button class="button primary" data-action="${escapeAttr(action)}">${escapeHtml(actionLabel)}</button></div>`; }

/** @param {string} title @param {string} description */
function unavailable(title, description) { return `<section class="unavailable"><div class="unavailable-mark" aria-hidden="true">↻</div><div><span class="eyebrow">INTEGRATION PENDING</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><a class="inline-link" href="/docs/">Inspect available endpoints →</a></div></section>`; }

/** @param {ViewState} state */
function banner(state) {
  if (state.error) return `<div class="banner error" role="alert"><div><strong>Couldn’t complete that request</strong><p>${escapeHtml(state.error.message)}${state.error.requestId ? ` <small>Request ${escapeHtml(state.error.requestId)}</small>` : ""}</p></div><button type="button" data-action="dismiss-banner" aria-label="Dismiss">×</button></div>`;
  if (state.notice) return `<div class="banner success" role="status"><div><strong>Done</strong><p>${escapeHtml(state.notice)}</p></div><button type="button" data-action="dismiss-banner" aria-label="Dismiss">×</button></div>`;
  return "";
}

/** @param {ViewState} state */
function reauthenticationBanner(state) {
  if (!state.signedIn || state.mutationReady) return "";
  return `<div class="banner warning" role="status"><div><strong>Confirm before making changes</strong><p>This tab restored your HttpOnly session, but the CSRF proof intentionally exists only in memory.</p></div><button class="button subtle" type="button" data-action="reauthenticate">Confirm password</button></div>`;
}

/** @param {string} route */
function titleFor(route) { return routes.find(([value]) => value === route)?.[1] ?? "Overview"; }
function dayPart() { const hour = new Date().getHours(); return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"; }
/** @param {string} value */
function humanize(value) { return value.replaceAll(/[._-]+/gu, " ").replace(/^./u, (letter) => letter.toUpperCase()); }
/** @param {string} value */
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date); }
/** @param {number} value */
function formatBytes(value) { if (!Number.isFinite(value) || value < 0) return "Unknown size"; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / (1024 * 1024)).toFixed(1)} MiB`; }
/** @param {string} value */
function relativeTime(value) { const time = new Date(value).valueOf(); if (!Number.isFinite(time)) return "Unknown"; const delta = Date.now() - time; if (delta < 60_000) return "Now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`; return formatDate(value); }
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value */
export function escapeHtml(value) { return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
/** @param {unknown} value */
function escapeAttr(value) { return escapeHtml(value); }
