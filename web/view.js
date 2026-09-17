// @ts-check

/** @typedef {import('./client.js').SocialGitClient} SocialGitClient */
/** @typedef {{id:string, platform:'reddit'|'x', expectedNativeUserId:string, actualNativeUserId:string|null, label:string|null, status:string, createdAt:string, updatedAt:string}} Account */
/** @typedef {{accountId:string,generation:number,status:string,connectedAt:string,revokedAt:string|null}} Connection */
/** @typedef {{id:string,sequence:number,callerId:string|null,accountId:string|null,type:string,outcome:string,data:unknown,occurredAt:string}} AuditEvent */
/** @typedef {{operation:string,summary?:string,mode?:string,productionEnabled?:boolean,disabledReason?:string,disabledReasons?:string[]}} CapabilityDetail */
/** @typedef {{platform:string,capabilities:string[],unsupportedCapabilities:Record<string,string>,details:CapabilityDetail[],source:'account'|'platform',error?:string}} AccountCapabilities */
/** @typedef {{accounts:Account[],connections:Record<string,Connection|null>,capabilities:Record<string,AccountCapabilities|null>,audit:AuditEvent[],health:{ready:boolean,checks:Record<string,boolean|string|number>}}} Overview */
/** @typedef {{route:string,signedIn:boolean,mutationReady:boolean,busy:boolean,error:null|{message:string,requestId?:string|null},notice:string|null,overview:Overview|null,keys:null|{items:Array<{id:string,name:string,prefix:string,scopes:string[],createdAt:string,lastUsedAt:string|null}>},keysUnavailable:boolean,backups:null|{items:Array<{id:string,status:string,createdAt:string,expiresAt:string,completedAt:string|null,sizeBytes:number|null,databaseCount:3,errorCode?:string}>},upgrade:null|{currentVersion:string,latestVersion:null,updateAvailable:false,channel:string,automation?:string,message?:string},settingsUnavailable:boolean,action:unknown}} ViewState */

const routes = [
  ["dashboard", "Overview"],
  ["accounts", "Accounts"],
  ["keys", "API keys"],
  ["activity", "Activity & jobs"],
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
      <header class="topbar"><button class="mobile-menu" type="button" data-action="toggle-menu" aria-label="Open navigation" aria-expanded="false">☰</button><div><span class="eyebrow">SELF-HOSTED WORKSPACE</span><strong>${escapeHtml(titleFor(state.route))}</strong></div><div class="top-actions"><a class="icon-button" href="/openapi.json" target="_blank" rel="noreferrer" aria-label="Open API documentation">API</a><button class="avatar" type="button" data-action="signout" title="Sign out">SG</button></div></header>
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
    case "settings": return renderSettings(state);
    default: return renderDashboard(state);
  }
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
    <section class="callout"><div class="callout-icon" aria-hidden="true">↗</div><div><h2>Build against one stable API</h2><p>Use the generated OpenAPI contract or MCP endpoint. Platform sessions never enter browser storage.</p></div><a class="button subtle" href="/openapi.json" target="_blank" rel="noreferrer">Explore API</a></section>
    ${apiExamples(accounts)}`;
}

/** @param {ViewState} state */
function renderAccounts(state) {
  const accounts = state.overview?.accounts ?? [];
  const reddit = accounts.filter((account) => account.platform === "reddit").length;
  const x = accounts.filter((account) => account.platform === "x").length;
  const connected = accounts.filter((account) => state.overview?.connections[account.id]?.status === "active").length;
  return `<section class="page-head compact"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h1>Social accounts</h1><p>Register a platform identity, inspect its admitted capabilities, and manage its Core-custodied session generation.</p><div class="health-summary" aria-label="Multi-account health"><span>${accounts.length} registered</span><span>${connected} connected</span><span>${reddit} Reddit</span><span>${x} X</span></div></div><button class="button primary" type="button" data-action="show-account-form" ${state.mutationReady ? "" : 'disabled title="Confirm your password to make changes"'}>Add account</button></section>
    <section class="panel form-panel hidden" data-region="account-form"><div class="panel-head"><div><span class="eyebrow">NEW ACCOUNT</span><h2>Register a social identity</h2></div></div>
      <form data-form="account" class="form-grid"><label>Platform <select name="platform" data-field="platform" aria-describedby="platform-guidance"><option value="reddit">Reddit</option><option value="x">X (registration only)</option></select></label><label>Label <input name="label" maxlength="120" placeholder="Community account"></label><label><span data-platform-identity-label>Expected Reddit native user ID</span><input name="expectedNativeUserId" required maxlength="128" autocomplete="off" placeholder="reddit native user ID" aria-describedby="native-identity-help"></label><p class="field-help" id="native-identity-help" data-platform-identity-help>Use the immutable native ID returned by Reddit, not a display name or email.</p><div class="platform-guidance" id="platform-guidance"><strong data-platform-guidance-title>Reddit can connect after a session file is staged on the server.</strong><span data-platform-guidance-detail>Stage the session outside this browser, then enter only its one-time filename. Never paste cookies or session JSON.</span></div><div class="form-actions"><button class="button primary" ${state.busy || !state.mutationReady ? "disabled" : ""}>Register account</button><button class="button ghost" type="button" data-action="hide-account-form">Cancel</button></div></form>
    </section>
    <section class="cards">${accounts.length ? accounts.map((account) => accountCard(account, state.overview?.connections[account.id] ?? null, state.overview?.capabilities?.[account.id] ?? null, state.mutationReady)).join("") : emptyState("No accounts yet", "Register a Reddit identity for admitted use, or an X identity for inventory while X production admission remains disabled.", "Add account", "show-account-form")}</section>`;
}

/** @param {ViewState} state */
function renderKeys(state) {
  const keys = state.keys?.items ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">PROGRAMMATIC ACCESS</span><h1>API keys</h1><p>Create least-privilege credentials for your apps and automations.</p></div><button class="button primary" type="button" data-action="show-key-form" ${state.keysUnavailable || !state.mutationReady ? "disabled" : ""}>Create key</button></section>
    ${state.keysUnavailable ? unavailable("API key management is waiting for the API key service", "This server build does not expose API-key management yet. Owner cookie authentication is active.") : `<section class="panel form-panel hidden" data-region="key-form"><form data-form="key" class="form-grid"><label>Key name <input name="name" maxlength="80" required placeholder="Production automation"></label><fieldset><legend>Scopes</legend><label class="check"><input type="checkbox" name="scopes" value="accounts:read" checked> Read accounts</label><label class="check"><input type="checkbox" name="scopes" value="accounts:write"> Register accounts</label><label class="check"><input type="checkbox" name="scopes" value="connections:read"> Read connection health</label><label class="check"><input type="checkbox" name="scopes" value="connections:write"> Connect and revoke sessions</label><label class="check"><input type="checkbox" name="scopes" value="social:read" checked> Read social data</label><label class="check"><input type="checkbox" name="scopes" value="social:write"> Create social actions</label><label class="check"><input type="checkbox" name="scopes" value="actions:read"> Read action status</label><label class="check"><input type="checkbox" name="scopes" value="audit:read"> Read audit log</label><label class="check"><input type="checkbox" name="scopes" value="webhooks:read"> Read webhook delivery state</label><label class="check"><input type="checkbox" name="scopes" value="webhooks:write"> Manage webhook subscriptions</label></fieldset><div class="form-actions"><button class="button primary" ${state.mutationReady ? "" : "disabled"}>Create key</button><button class="button ghost" type="button" data-action="hide-key-form">Cancel</button></div></form></section>
    <section class="panel table-panel">${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Token</th><th>Scopes</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${keys.map((key) => `<tr><td><strong>${escapeHtml(key.name)}</strong><small>${formatDate(key.createdAt)}</small></td><td><code>${escapeHtml(key.prefix)}••••••••</code></td><td>${escapeHtml(key.scopes.join(", "))}</td><td>${key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</td><td><button class="text-danger" data-action="revoke-key" data-id="${escapeAttr(key.id)}">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("No API keys", "Create a scoped key for an application or automation. The secret is shown only once.", "Create key", "show-key-form")}</section>`}`;
}

/** @param {ViewState} state */
function renderActivity(state) {
  const events = state.overview?.audit ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">TRACE EVERY CHANGE</span><h1>Activity & jobs</h1><p>Review redacted audit events or look up a durable write action by ID.</p></div></section>
    <section class="split-grid activity-layout"><div class="panel"><div class="panel-head"><div><span class="eyebrow">AUDIT TRAIL</span><h2>Recent events</h2></div><button class="icon-button" type="button" data-action="refresh" aria-label="Refresh activity">↻</button></div>${activityRows(events)}</div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">JOB LOOKUP</span><h2>Inspect an action</h2></div></div><form class="stack-form" data-form="action"><label>Action ID <input name="actionId" required maxlength="128" placeholder="action_…"></label><button class="button primary">Look up job</button></form>${state.action ? renderAction(state.action) : `<div class="hint"><strong>Durable by design</strong><p>Every write has a caller-scoped idempotency key and an inspectable lifecycle. UNKNOWN actions are never submitted again automatically.</p><code>GET /v1/actions/&lt;ACTION_ID&gt;</code></div>`}</div></section>`;
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
  const status = xBlocked ? "production disabled" : connection?.status ?? account.status;
  const nextGeneration = (connection?.generation ?? 0) + 1;
  const connectionMode = connection ? "refresh" : "import";
  const connectLabel = connection ? (connection.status === "active" ? "Refresh session" : "Reconnect") : "Connect session";
  const controls = account.platform === "x"
    ? `<span class="blocked-control" title="X production connection is not admitted">Connection unavailable</span>${connection?.status === "active" ? `<button class="button ghost" data-action="revoke-account" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Revoke fixture session</button>` : ""}`
    : `<button class="button subtle" data-action="show-connect" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>${connectLabel}</button>${connection?.status === "active" ? `<button class="button ghost" data-action="revoke-account" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Revoke</button>` : ""}`;
  const connectForm = account.platform === "reddit" ? `<form class="inline-connect hidden" data-form="connect" data-mode="${connectionMode}" data-account-id="${escapeAttr(account.id)}"><div class="session-guidance"><strong>Stage the session on the server first.</strong><p>Enter only the one-time import filename without <code>.json</code>. This is not a path or URI. Never paste cookies or raw session JSON.</p></div><label>One-time import handle <input name="vaultHandle" required maxlength="128" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,127}" autocomplete="off" placeholder="reddit-session-2026-09" aria-describedby="handle-help-${escapeAttr(account.id)}"></label><small id="handle-help-${escapeAttr(account.id)}">Allowed: letters, numbers, dot, underscore, and hyphen.</small><input name="generation" type="hidden" value="${nextGeneration}"><span class="generation-note">${connection ? "Next" : "Initial"} generation: <strong>${nextGeneration}</strong></span><button class="button primary" ${mutationReady ? "" : "disabled"}>${connectionMode === "refresh" ? "Replace session" : "Connect"}</button></form>` : "";
  return `<article class="account-card ${xBlocked ? "account-card-blocked" : ""}"><div class="account-card-top">${platformLogo(account.platform, true)}${statusPill(status)}</div><h2>${escapeHtml(account.label || account.expectedNativeUserId)}</h2><p><span class="sr-only">${escapeHtml(platformName(account.platform))} native identity:</span>${escapeHtml(account.actualNativeUserId || account.expectedNativeUserId)}</p><dl><div><dt>Platform</dt><dd>${escapeHtml(platformName(account.platform))}</dd></div><div><dt>Session generation</dt><dd>${connection?.generation ?? "Not connected"}</dd></div><div><dt>Updated</dt><dd>${formatDate(account.updatedAt)}</dd></div></dl>${capabilityPanel(account, capabilities)}<div class="card-actions">${controls}</div>${connectForm}<details class="api-example"><summary>API example</summary><pre>${escapeHtml(capabilityCurl(account.id))}</pre></details></article>`;
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
  return `<section class="panel examples-panel" aria-labelledby="api-examples-title"><div class="panel-head"><div><span class="eyebrow">COPY-SAFE REQUESTS</span><h2 id="api-examples-title">API examples</h2></div><a href="/openapi.json" target="_blank" rel="noreferrer">Full contract</a></div><div class="example-grid"><div><strong>Inspect admission and capabilities</strong><pre>${escapeHtml(capabilityCurl(exampleId))}</pre></div><div><strong>Inspect a durable job</strong><pre>${escapeHtml(`curl -H "Authorization: Bearer <API_KEY>" \\\n  http://localhost:8080/v1/actions/<ACTION_ID>`)}</pre></div></div><p class="example-note">Use a scoped API key. Never put social cookies, session JSON, or the owner browser cookie in these requests. X write examples are intentionally omitted while production admission is disabled.</p></section>`;
}

/** @param {unknown} value */
function renderAction(value) {
  if (!isRecord(value)) return `<div class="hint"><strong>Invalid action response</strong><p>The response could not be displayed safely.</p></div>`;
  const state = typeof value.state === "string" ? value.state : "unknown";
  const id = typeof value.id === "string" ? value.id : "Unknown";
  const kind = typeof value.kind === "string" ? value.kind : "Unknown";
  const accountId = typeof value.accountId === "string" ? value.accountId : "Unknown";
  const updatedAt = typeof value.updatedAt === "string" ? formatDate(value.updatedAt) : "Unknown";
  const ambiguous = value.submissionMayHaveStarted === true || state === "UNKNOWN";
  return `<section class="job-card" aria-label="Action status"><div class="job-head"><div><span class="eyebrow">ACTION ${escapeHtml(id)}</span><h3>${escapeHtml(humanize(kind))}</h3></div>${statusPill(state)}</div><dl><div><dt>Account</dt><dd>${escapeHtml(accountId)}</dd></div><div><dt>Updated</dt><dd>${escapeHtml(updatedAt)}</dd></div><div><dt>Idempotency</dt><dd>${escapeHtml(typeof value.idempotencyKey === "string" ? value.idempotencyKey : "Unknown")}</dd></div></dl>${ambiguous ? `<div class="unknown-warning"><strong>Do not resubmit</strong><p>The platform may have received this action. Social Git will not retry it automatically.</p></div>` : ""}${value.result !== null && value.result !== undefined ? `<details><summary>Normalized result</summary><pre>${escapeHtml(JSON.stringify(value.result, null, 2))}</pre></details>` : ""}${value.error !== null && value.error !== undefined ? `<details><summary>Normalized error</summary><pre>${escapeHtml(JSON.stringify(value.error, null, 2))}</pre></details>` : ""}</section>`;
}

/** @param {string} label @param {string} value @param {string} detail @param {boolean} good */
function metric(label, value, detail, good) { return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small><i class="status-dot ${good ? "good" : "warn"}"></i>${escapeHtml(detail)}</small></article>`; }

/** @param {string} status */
function statusPill(status) { const good = status === "active" || status === "ready"; return `<span class="pill ${good ? "success" : status === "revoked" || status === "failed" ? "danger" : "warning"}"><i></i>${escapeHtml(humanize(status))}</span>`; }

/** @param {string} title @param {string} description @param {string} actionLabel @param {string} action */
function emptyState(title, description, actionLabel, action) { return `<div class="empty"><div class="empty-art" aria-hidden="true"><span></span><span></span><span></span></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><button class="button primary" data-action="${escapeAttr(action)}">${escapeHtml(actionLabel)}</button></div>`; }

/** @param {string} title @param {string} description */
function unavailable(title, description) { return `<section class="unavailable"><div class="unavailable-mark" aria-hidden="true">↻</div><div><span class="eyebrow">INTEGRATION PENDING</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><a class="inline-link" href="/openapi.json" target="_blank" rel="noreferrer">Inspect available endpoints →</a></div></section>`; }

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
