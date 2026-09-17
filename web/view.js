// @ts-check

/** @typedef {import('./client.js').SocialGitClient} SocialGitClient */
/** @typedef {{id:string, platform:string, expectedNativeUserId:string, actualNativeUserId:string|null, label:string|null, status:string, createdAt:string, updatedAt:string}} Account */
/** @typedef {{accountId:string,generation:number,status:string,connectedAt:string,revokedAt:string|null}} Connection */
/** @typedef {{id:string,sequence:number,callerId:string|null,accountId:string|null,type:string,outcome:string,data:unknown,occurredAt:string}} AuditEvent */
/** @typedef {{accounts:Account[],connections:Record<string,Connection|null>,audit:AuditEvent[],health:{ready:boolean,checks:Record<string,boolean|string|number>}}} Overview */
/** @typedef {{route:string,signedIn:boolean,mutationReady:boolean,busy:boolean,error:null|{message:string,requestId?:string|null},notice:string|null,overview:Overview|null,keys:null|{items:Array<{id:string,name:string,prefix:string,scopes:string[],createdAt:string,lastUsedAt:string|null}>},keysUnavailable:boolean,backups:null|{items:Array<{id:string,status:string,createdAt:string,sizeBytes:number|null}>},upgrade:null|{currentVersion:string,latestVersion:string|null,updateAvailable:boolean,channel:string},settingsUnavailable:boolean,action:unknown}} ViewState */

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
  const active = accounts.filter((account) => account.status === "active").length;
  const attention = accounts.filter((account) => account.status !== "active").length;
  return `<section class="page-head"><div><span class="eyebrow">OPERATIONS AT A GLANCE</span><h1>Good ${dayPart()}.</h1><p>Manage account sessions, API access, and every social action from one private workspace.</p></div><a class="button primary" href="#accounts">Add an account <span aria-hidden="true">→</span></a></section>
    <section class="metrics" aria-label="Workspace summary">
      ${metric("Connected accounts", String(active), active ? "Healthy sessions" : "Connect your first account", active > 0)}
      ${metric("Needs attention", String(attention), attention ? "Review account health" : "Nothing blocked", attention === 0)}
      ${metric("Core status", overview?.health.ready ? "Ready" : "Unavailable", overview?.health.ready ? "API and workers responding" : "Inspect readiness checks", Boolean(overview?.health.ready))}
    </section>
    <section class="split-grid">
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">ACCOUNTS</span><h2>Connection health</h2></div><a href="#accounts">View all</a></div>${accountRows(accounts.slice(0, 4), overview?.connections ?? {})}</div>
      <div class="panel"><div class="panel-head"><div><span class="eyebrow">RECENT</span><h2>Workspace activity</h2></div><a href="#activity">View log</a></div>${activityRows(overview?.audit.slice(0, 5) ?? [])}</div>
    </section>
    <section class="callout"><div class="callout-icon" aria-hidden="true">↗</div><div><h2>Build against one stable API</h2><p>Use the generated OpenAPI contract or MCP endpoint. Platform sessions never enter browser storage.</p></div><a class="button subtle" href="/openapi.json" target="_blank" rel="noreferrer">Explore API</a></section>`;
}

/** @param {ViewState} state */
function renderAccounts(state) {
  const accounts = state.overview?.accounts ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h1>Social accounts</h1><p>Register an identity, then connect it with an externally staged encrypted session reference.</p></div><button class="button primary" type="button" data-action="show-account-form" ${state.mutationReady ? "" : 'disabled title="Confirm your password to make changes"'}>Add account</button></section>
    <section class="panel form-panel hidden" data-region="account-form"><div class="panel-head"><div><span class="eyebrow">NEW ACCOUNT</span><h2>Register a Reddit identity</h2></div></div>
      <form data-form="account" class="form-grid"><label>Label <input name="label" maxlength="120" placeholder="Community account"></label><label>Expected native user ID <input name="expectedNativeUserId" required maxlength="128" autocomplete="off" placeholder="reddit-user-id"></label><div class="form-actions"><button class="button primary" ${state.busy || !state.mutationReady ? "disabled" : ""}>Register account</button><button class="button ghost" type="button" data-action="hide-account-form">Cancel</button></div></form>
    </section>
    <section class="cards">${accounts.length ? accounts.map((account) => accountCard(account, state.overview?.connections[account.id] ?? null, state.mutationReady)).join("") : emptyState("No accounts yet", "Register your first Reddit identity. Social Git verifies that the imported session belongs to exactly that account.", "Add account", "show-account-form")}</section>`;
}

/** @param {ViewState} state */
function renderKeys(state) {
  const keys = state.keys?.items ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">PROGRAMMATIC ACCESS</span><h1>API keys</h1><p>Create least-privilege credentials for your apps and automations.</p></div><button class="button primary" type="button" data-action="show-key-form" ${state.keysUnavailable || !state.mutationReady ? "disabled" : ""}>Create key</button></section>
    ${state.keysUnavailable ? unavailable("API key management is waiting for the API key service", "The DYN-106 client boundary is ready, but this server build does not expose API-key management yet. Owner cookie authentication is active.") : `<section class="panel form-panel hidden" data-region="key-form"><form data-form="key" class="form-grid"><label>Key name <input name="name" maxlength="80" required placeholder="Production automation"></label><fieldset><legend>Scopes</legend><label class="check"><input type="checkbox" name="scopes" value="accounts:read" checked> Read accounts</label><label class="check"><input type="checkbox" name="scopes" value="social:read" checked> Read social data</label><label class="check"><input type="checkbox" name="scopes" value="social:write"> Create social actions</label><label class="check"><input type="checkbox" name="scopes" value="audit:read"> Read audit log</label></fieldset><div class="form-actions"><button class="button primary" ${state.mutationReady ? "" : "disabled"}>Create key</button><button class="button ghost" type="button" data-action="hide-key-form">Cancel</button></div></form></section>
    <section class="panel table-panel">${keys.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Token</th><th>Scopes</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${keys.map((key) => `<tr><td><strong>${escapeHtml(key.name)}</strong><small>${formatDate(key.createdAt)}</small></td><td><code>${escapeHtml(key.prefix)}••••••••</code></td><td>${escapeHtml(key.scopes.join(", "))}</td><td>${key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</td><td><button class="text-danger" data-action="revoke-key" data-id="${escapeAttr(key.id)}">Revoke</button></td></tr>`).join("")}</tbody></table></div>` : emptyState("No API keys", "Create a scoped key for an application or automation. The secret is shown only once.", "Create key", "show-key-form")}</section>`}`;
}

/** @param {ViewState} state */
function renderActivity(state) {
  const events = state.overview?.audit ?? [];
  return `<section class="page-head compact"><div><span class="eyebrow">TRACE EVERY CHANGE</span><h1>Activity & jobs</h1><p>Review redacted audit events or look up a durable write action by ID.</p></div></section>
    <section class="split-grid activity-layout"><div class="panel"><div class="panel-head"><div><span class="eyebrow">AUDIT TRAIL</span><h2>Recent events</h2></div><button class="icon-button" type="button" data-action="refresh" aria-label="Refresh activity">↻</button></div>${activityRows(events)}</div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">JOB LOOKUP</span><h2>Inspect an action</h2></div></div><form class="stack-form" data-form="action"><label>Action ID <input name="actionId" required maxlength="128" placeholder="action_…"></label><button class="button primary">Look up job</button></form>${state.action ? `<pre class="result" aria-label="Action result">${escapeHtml(JSON.stringify(state.action, null, 2))}</pre>` : `<div class="hint"><strong>Durable by design</strong><p>Every write has a caller-scoped idempotency key and an inspectable lifecycle. UNKNOWN actions are never submitted again automatically.</p></div>`}</div></section>`;
}

/** @param {ViewState} state */
function renderSettings(state) {
  if (state.settingsUnavailable) return `<section class="page-head compact"><div><span class="eyebrow">INSTANCE OPERATIONS</span><h1>Settings</h1><p>Backups, updates, and deployment-safe instance controls.</p></div></section>${unavailable("Instance management is not enabled in this build", "The control-plane client is wired and will activate when the identity and operations endpoints land. Use the documented container backup commands in the meantime.")}`;
  const backups = state.backups?.items ?? [];
  const upgrade = state.upgrade;
  return `<section class="page-head compact"><div><span class="eyebrow">INSTANCE OPERATIONS</span><h1>Settings</h1><p>Backups, updates, and deployment-safe instance controls.</p></div></section>
    <section class="split-grid"><div class="panel"><div class="panel-head"><div><span class="eyebrow">BACKUPS</span><h2>Encrypted snapshots</h2></div><button class="button subtle" data-action="create-backup" ${state.mutationReady ? "" : "disabled"}>Create backup</button></div>${backups.length ? backups.map((backup) => `<div class="list-row"><div><strong>${escapeHtml(backup.id)}</strong><small>${formatDate(backup.createdAt)}</small></div><span class="pill ${backup.status === "ready" ? "success" : ""}">${escapeHtml(backup.status)}</span></div>`).join("") : `<div class="empty compact-empty"><h3>No backups yet</h3><p>Create a tenant-bound encrypted backup before upgrades.</p></div>`}</div>
    <div class="panel"><div class="panel-head"><div><span class="eyebrow">UPDATES</span><h2>Release channel</h2></div><span class="pill">${escapeHtml(upgrade?.channel ?? "stable")}</span></div><div class="version-card"><span>Installed</span><strong>${escapeHtml(upgrade?.currentVersion ?? "Unknown")}</strong><span>${upgrade?.updateAvailable ? `Version ${escapeHtml(upgrade.latestVersion ?? "new")} is available` : "You are up to date"}</span></div><a class="button subtle full" href="https://github.com/" target="_blank" rel="noreferrer">Read upgrade guide</a></div></section>`;
}

/** @param {ViewState} state */
function renderSignIn(state) {
  return `<main id="main" class="auth-page"><section class="auth-visual"><div class="auth-brand"><span class="brand-mark">S</span><strong>Social Git</strong></div><div class="visual-copy"><span class="eyebrow">YOUR SOCIAL INFRASTRUCTURE</span><h1>One private gateway.<br><em>Every account.</em></h1><p>Operate Reddit today and more platforms tomorrow through a stable, self-hosted interface.</p></div><div class="visual-proof"><span>HttpOnly owner session</span><span>Encrypted social sessions</span><span>Auditable actions</span></div></section><section class="auth-form"><div class="auth-card">${banner(state)}<span class="eyebrow">WELCOME BACK</span><h2>Sign in to your workspace</h2><p>Your server creates a secure, same-site owner session. Credentials and session material are never saved in browser storage.</p><form data-form="signin" class="stack-form"><label>Email <input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label><label>Password <input type="password" name="password" required maxlength="256" autocomplete="current-password" placeholder="Your owner password"></label><button class="button primary full" ${state.busy ? "disabled" : ""}>${state.busy ? "Checking…" : "Sign in"}</button></form><div class="auth-help"><span>Owner access stays on this installation.</span><a href="/openapi.json">API contract</a></div></div><footer>Private by default · Cookie protected with HttpOnly and SameSite</footer></section></main>`;
}

/** @param {ViewState} state */
function renderSetup(state) {
  return `<main id="main" class="setup-page"><header class="setup-top"><span class="brand"><span class="brand-mark">S</span><strong>Social Git</strong></span><span class="pill">Self-hosted setup</span></header><section class="setup-wrap"><div class="step-copy"><span class="step-number">01</span><span class="eyebrow">CREATE THE OWNER</span><h1>Make this workspace yours.</h1><p>The first owner controls API keys, backups, and account access. The one-time setup endpoint closes permanently after this account is created.</p><ul><li><span>✓</span> Local owner account</li><li><span>✓</span> HttpOnly browser session</li><li><span>✓</span> No hosted dependency</li></ul></div><div class="setup-card">${banner(state)}<form data-form="setup" class="stack-form"><label>Your name <input name="displayName" required minlength="1" maxlength="120" autocomplete="name" placeholder="Primary Owner"></label><label>Owner email <input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"></label><label>Password <input name="password" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="At least 12 characters"></label><p class="field-help">Use a unique password. Configure HTTPS at your reverse proxy before adding real accounts.</p><button class="button primary full" ${state.busy ? "disabled" : ""}>${state.busy ? "Creating owner…" : "Create owner account"}</button></form></div></section></main>`;
}

/** @param {Account[]} accounts @param {Record<string,Connection|null>} connections */
function accountRows(accounts, connections) {
  if (!accounts.length) return `<div class="empty compact-empty"><h3>No accounts connected</h3><p>Add an account to start using the API.</p><a class="inline-link" href="#accounts">Add your first account →</a></div>`;
  return `<div class="list">${accounts.map((account) => `<div class="list-row"><div class="account-id"><span class="platform-logo">r/</span><div><strong>${escapeHtml(account.label || account.expectedNativeUserId)}</strong><small>${escapeHtml(account.actualNativeUserId || account.expectedNativeUserId)}</small></div></div>${statusPill(connections[account.id]?.status ?? account.status)}</div>`).join("")}</div>`;
}

/** @param {AuditEvent[]} events */
function activityRows(events) {
  if (!events.length) return `<div class="empty compact-empty"><h3>No activity yet</h3><p>Account and action events will appear here.</p></div>`;
  return `<ol class="timeline">${events.map((event) => `<li><span class="timeline-dot" aria-hidden="true"></span><div><strong>${escapeHtml(humanize(event.type))}</strong><p>${escapeHtml(event.outcome)}${event.accountId ? ` · ${escapeHtml(event.accountId)}` : ""}</p></div><time datetime="${escapeAttr(event.occurredAt)}">${relativeTime(event.occurredAt)}</time></li>`).join("")}</ol>`;
}

/** @param {Account} account @param {Connection|null} connection @param {boolean} mutationReady */
function accountCard(account, connection, mutationReady) {
  const disconnected = !connection || connection.status !== "active";
  return `<article class="account-card"><div class="account-card-top"><span class="platform-logo large">r/</span>${statusPill(connection?.status ?? account.status)}</div><h2>${escapeHtml(account.label || account.expectedNativeUserId)}</h2><p>${escapeHtml(account.actualNativeUserId || account.expectedNativeUserId)}</p><dl><div><dt>Platform</dt><dd>Reddit</dd></div><div><dt>Generation</dt><dd>${connection?.generation ?? "—"}</dd></div><div><dt>Updated</dt><dd>${formatDate(account.updatedAt)}</dd></div></dl><div class="card-actions">${disconnected ? `<button class="button subtle" data-action="show-connect" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Connect session</button>` : `<button class="button ghost" data-action="revoke-account" data-id="${escapeAttr(account.id)}" ${mutationReady ? "" : "disabled"}>Revoke</button>`}</div>${disconnected ? `<form class="inline-connect hidden" data-form="connect" data-account-id="${escapeAttr(account.id)}"><label>Opaque vault handle <input name="vaultHandle" required maxlength="256" autocomplete="off" placeholder="vault://staged/reference"></label><label>Generation <input name="generation" type="number" min="1" value="1" required></label><button class="button primary" ${mutationReady ? "" : "disabled"}>Connect</button></form>` : ""}</article>`;
}

/** @param {string} label @param {string} value @param {string} detail @param {boolean} good */
function metric(label, value, detail, good) { return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small><i class="status-dot ${good ? "good" : "warn"}"></i>${escapeHtml(detail)}</small></article>`; }

/** @param {string} status */
function statusPill(status) { const good = status === "active" || status === "ready"; return `<span class="pill ${good ? "success" : status === "revoked" ? "danger" : "warning"}"><i></i>${escapeHtml(humanize(status))}</span>`; }

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
/** @param {string} value */
function relativeTime(value) { const time = new Date(value).valueOf(); if (!Number.isFinite(time)) return "Unknown"; const delta = Date.now() - time; if (delta < 60_000) return "Now"; if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`; if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`; return formatDate(value); }
/** @param {unknown} value */
export function escapeHtml(value) { return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character); }
/** @param {unknown} value */
function escapeAttr(value) { return escapeHtml(value); }
