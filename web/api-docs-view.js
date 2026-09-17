// @ts-check

/** @typedef {{operationId:string,method:string,path:string,summary:string,scope:string,platform:string,availability:string,disabledReasons:string[],parameters:Array<Record<string,any>>,requestBody:any,responses:any,security:Array<Record<string,unknown>>}} ExplorerOperation */

/** @param {Record<string, any>} spec */
export function flattenOperations(spec) {
  /** @type {ExplorerOperation[]} */
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec?.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem?.[method];
      if (!operation?.operationId) continue;
      operations.push({
        operationId: String(operation.operationId), method: method.toUpperCase(), path,
        summary: String(operation.summary ?? ""), scope: String(operation["x-required-scope"] ?? "public"),
        platform: String(operation["x-social-git-platform"] ?? "core"),
        availability: String(operation["x-social-git-availability"] ?? "production"),
        disabledReasons: Array.isArray(operation["x-social-git-disabled-reasons"]) ? operation["x-social-git-disabled-reasons"].map(String) : [],
        parameters: Array.isArray(operation.parameters) ? operation.parameters : [],
        requestBody: operation.requestBody ?? null, responses: operation.responses ?? {}, security: operation.security ?? [],
      });
    }
  }
  return operations.sort((left, right) => left.platform.localeCompare(right.platform) || left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

/** @param {{spec:Record<string,any>|null,query:string,platform:string,availability:string,activeOperationId:string|null,error:string|null}} state */
export function renderExplorer(state) {
  if (state.error) return shell(`<section class="docs-state"><h1>API explorer unavailable</h1><p>${escapeHtml(state.error)}</p><button type="button" data-action="reload">Retry</button></section>`);
  if (!state.spec) return shell('<section class="docs-state"><div class="docs-spinner" aria-hidden="true"></div><p>Loading the local OpenAPI contract…</p></section>');
  const all = flattenOperations(state.spec);
  const query = state.query.trim().toLowerCase();
  const filtered = all.filter((operation) => (!query || [operation.operationId, operation.summary, operation.path, operation.scope].some((value) => value.toLowerCase().includes(query)))
    && (state.platform === "all" || operation.platform === state.platform)
    && (state.availability === "all" || operation.availability === state.availability));
  const active = filtered.find((operation) => operation.operationId === state.activeOperationId) ?? filtered[0] ?? null;
  const counts = { production: all.filter(({ availability }) => availability === "production").length, fixture: all.filter(({ availability }) => availability === "fixture_only").length };
  return shell(`<header class="docs-header"><div><a class="back-link-docs" href="/app/">← Control plane</a><span class="eyebrow">LOCAL RELEASE ASSET</span><h1>${escapeHtml(state.spec.info?.title ?? "Social Git API")}</h1><p>${escapeHtml(state.spec.info?.description ?? "")}</p></div><div class="docs-actions"><a href="/openapi.json" target="_blank" rel="noreferrer">Raw OpenAPI</a><span>v${escapeHtml(state.spec.info?.version ?? "")}</span></div></header>
    <section class="truth-banner"><strong>Availability is generated from the runtime contract.</strong><span><b>${counts.production}</b> production operations</span><span><b>${counts.fixture}</b> X fixture-only operations</span><span>Unsupported features are never shown as endpoints.</span></section>
    <section class="docs-filters" aria-label="Filter operations"><label>Search <input type="search" data-filter="query" value="${escapeAttr(state.query)}" placeholder="Operation, path, scope…"></label><label>Platform <select data-filter="platform">${options(["all", "core", "reddit", "x"], state.platform)}</select></label><label>Availability <select data-filter="availability">${options(["all", "production", "fixture_only"], state.availability)}</select></label></section>
    <main class="docs-layout" id="main"><nav class="operation-list" aria-label="API operations"><p>${filtered.length} of ${all.length} operations</p>${filtered.map((operation) => operationButton(operation, active?.operationId === operation.operationId)).join("") || '<div class="no-results">No operation matches these filters.</div>'}</nav><section class="operation-detail" aria-live="polite">${active ? renderOperation(active) : '<div class="no-results">Select another filter to inspect an operation.</div>'}</section></main>`);
}

/** @param {ExplorerOperation} operation @param {boolean} active */
function operationButton(operation, active) {
  return `<button type="button" class="operation-row ${active ? "active" : ""}" data-operation="${escapeAttr(operation.operationId)}" aria-pressed="${active}"><span class="method ${operation.method.toLowerCase()}">${operation.method}</span><span><strong>${escapeHtml(operation.summary)}</strong><code>${escapeHtml(operation.path)}</code></span><span class="availability ${escapeAttr(operation.availability)}">${availabilityLabel(operation.availability)}</span></button>`;
}

/** @param {ExplorerOperation} operation */
function renderOperation(operation) {
  const success = Object.entries(operation.responses).find(([status]) => /^2/u.test(status));
  const requestMedia = operation.requestBody?.content?.["application/json"];
  const responseMedia = success?.[1]?.content?.["application/json"];
  const requestExample = firstExample(requestMedia);
  const responseExamples = examples(responseMedia);
  const errorExamples = examples(operation.responses?.default?.content?.["application/json"]);
  const bearer = operation.security.some((entry) => Object.hasOwn(entry, "bearerAuth"));
  return `<article><div class="operation-title"><div><span class="method ${operation.method.toLowerCase()}">${operation.method}</span><span class="availability ${escapeAttr(operation.availability)}">${availabilityLabel(operation.availability)}</span></div><h2>${escapeHtml(operation.summary)}</h2><code>${escapeHtml(operation.path)}</code></div>
    <dl class="operation-meta"><div><dt>Operation ID</dt><dd>${escapeHtml(operation.operationId)}</dd></div><div><dt>Required scope</dt><dd>${escapeHtml(operation.scope)}</dd></div><div><dt>Platform</dt><dd>${escapeHtml(operation.platform)}</dd></div></dl>
    ${operation.disabledReasons.length ? `<aside class="gate-warning"><strong>Fixture contract only — production dispatch is denied.</strong><p>${operation.disabledReasons.map(escapeHtml).join(" · ")}</p></aside>` : ""}
    ${bearer ? `<form class="request-builder" data-request-builder data-operation-id="${escapeAttr(operation.operationId)}" data-method="${operation.method}" data-path="${escapeAttr(operation.path)}"><div class="section-head"><div><span class="eyebrow">INTERACTIVE REQUEST</span><h3>Build and send</h3></div><span>Credentials stay in memory and are never persisted.</span></div><label>API key <input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sgk_…"></label>${operation.parameters.map(parameterField).join("")}${requestMedia ? `<label>JSON body <textarea name="body" rows="9" spellcheck="false">${escapeHtml(JSON.stringify(requestExample ?? schemaExample(requestMedia.schema), null, 2))}</textarea></label>` : ""}<div class="request-actions"><button type="button" data-action="copy-curl">Copy cURL</button><button class="primary" type="submit" ${operation.availability === "fixture_only" ? "disabled title=\"Production dispatch is disabled\"" : ""}>Send request</button></div><pre class="curl-preview" data-curl-preview>${escapeHtml(buildCurl(operation))}</pre><div class="request-result" data-request-result hidden></div></form>` : '<aside class="browser-session-note">This owner browser-session operation is documented here but intentionally excluded from the API-key request runner.</aside>'}
    ${renderExamples("Success examples", responseExamples)}${renderExamples("Structured error examples", errorExamples)}
    <details class="schema-panel"><summary>Request schema</summary><pre>${escapeHtml(JSON.stringify(requestMedia?.schema ?? null, null, 2))}</pre></details><details class="schema-panel"><summary>Response schema</summary><pre>${escapeHtml(JSON.stringify(responseMedia?.schema ?? success?.[1] ?? null, null, 2))}</pre></details></article>`;
}

/** @param {Record<string,any>} parameter */
function parameterField(parameter) {
  const example = scalarExample(parameter.name, parameter.schema);
  return `<label>${escapeHtml(parameter.name)} <small>${escapeHtml(parameter.in)}${parameter.required ? " · required" : ""}</small><input name="${escapeAttr(`${parameter.in}:${parameter.name}`)}" ${parameter.required ? "required" : ""} value="${escapeAttr(String(example ?? ""))}" autocomplete="off"></label>`;
}

/** @param {string} title @param {Array<[string,unknown]>} values */
function renderExamples(title, values) {
  if (!values.length) return "";
  return `<section class="examples"><div class="section-head"><div><span class="eyebrow">VALIDATED CONTRACT DATA</span><h3>${escapeHtml(title)}</h3></div></div>${values.map(([name, value]) => `<details><summary>${escapeHtml(name)}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`).join("")}</section>`;
}

/** @param {ExplorerOperation} operation @param {Record<string,string>} values */
export function buildCurl(operation, values = {}) {
  let path = operation.path;
  for (const parameter of operation.parameters) {
    if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, encodeURIComponent(values[`path:${parameter.name}`] ?? String(scalarExample(parameter.name, parameter.schema) ?? `<${parameter.name}>`)));
  }
  const query = operation.parameters.filter(({ in: where }) => where === "query").flatMap((parameter) => {
    const value = values[`query:${parameter.name}`];
    return value ? [`${encodeURIComponent(parameter.name)}=${encodeURIComponent(value)}`] : [];
  });
  const lines = [`curl -X ${operation.method} \\`, `  -H ${shellQuote("Authorization: Bearer <API_KEY>")} \\`];
  const idempotency = values["header:Idempotency-Key"] ?? (operation.parameters.some(({ name }) => name === "Idempotency-Key") ? "<IDEMPOTENCY_KEY>" : "");
  if (idempotency) lines.push(`  -H ${shellQuote(`Idempotency-Key: ${idempotency}`)} \\`);
  if (operation.requestBody) {
    lines.push(`  -H ${shellQuote("Content-Type: application/json")} \\`);
    lines.push(`  --data ${shellQuote(values.body ?? JSON.stringify(firstExample(operation.requestBody?.content?.["application/json"]) ?? schemaExample(operation.requestBody?.content?.["application/json"]?.schema)))} \\`);
  }
  lines.push(`  ${shellQuote(`http://localhost:8080${path}${query.length ? `?${query.join("&")}` : ""}`)}`);
  return lines.join("\n");
}

/** @param {any} media */
function firstExample(media) { return examples(media)[0]?.[1] ?? null; }
/** @param {any} media @returns {Array<[string,unknown]>} */
function examples(media) { return Object.entries(media?.examples ?? {}).map(([name, entry]) => [name, /** @type {any} */ (entry)?.value]); }

/** @param {any} schema @returns {unknown} */
function schemaExample(schema) {
  if (!schema) return {};
  if (schema.oneOf) return schemaExample(schema.oneOf[0]);
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object") return Object.fromEntries((/** @type {string[]} */ (schema.required ?? [])).map((name) => [name, schemaExample(schema.properties?.[name])]));
  if (schema.type === "array") return [schemaExample(schema.items)];
  if (schema.type === "integer") return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  return "example";
}

/** @param {string} name @param {any} schema */
function scalarExample(name, schema) {
  /** @type {Record<string,string|number>} */
  const named = { accountId: "account_reddit_primary", actionId: "action_01JQEXAMPLE00000000000001", subscriptionId: "webhook_subscription_example", apiKeyId: "api_key_example", platform: "x", postId: "t3_example", subreddit: "selfhosted", username: "example_user", content: "submitted", query: "self hosted automation", limit: 25 };
  return named[name] ?? schema?.example ?? schema?.enum?.[0] ?? "";
}

/** @param {string[]} values @param {string} selected */
function options(values, selected) { return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${availabilityLabel(value)}</option>`).join(""); }
/** @param {string} value */
function availabilityLabel(value) { const labels = /** @type {Record<string,string>} */ ({ all: "All", production: "Production", fixture_only: "Fixture only", core: "Core", reddit: "Reddit", x: "X" }); return labels[value] ?? value; }
/** @param {string} content */
function shell(content) { return `<a class="skip-link" href="#main">Skip to content</a><div class="docs-shell">${content}</div>`; }
/** @param {unknown} value */
export function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
/** @param {unknown} value */
function escapeAttr(value) { return escapeHtml(value); }
/** @param {string} value */
function shellQuote(value) { return `'${value.replaceAll("'", `'"'"'`)}'`; }
