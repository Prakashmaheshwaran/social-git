// @ts-check

import { buildCurl, flattenOperations, renderExplorer } from "./api-docs-view.js";

const mountElement = document.querySelector("#api-docs");
if (!(mountElement instanceof HTMLElement)) throw new Error("API explorer root is missing");
/** @type {HTMLElement} */
const mount = mountElement;

const state = { spec: /** @type {Record<string,any>|null} */ (null), query: "", platform: "all", availability: "all", activeOperationId: /** @type {string|null} */ (null), error: /** @type {string|null} */ (null) };

mount.addEventListener("input", handleFilter);
mount.addEventListener("change", handleFilter);
mount.addEventListener("click", (event) => { void handleClick(event); });
mount.addEventListener("submit", (event) => { void handleSubmit(event); });

void load();

async function load() {
  state.error = null;
  render();
  try {
    const response = await fetch("/openapi.json", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!response.ok) throw new Error(`OpenAPI returned HTTP ${response.status}`);
    state.spec = /** @type {Record<string,any>} */ (await response.json());
    state.activeOperationId = flattenOperations(state.spec)[0]?.operationId ?? null;
  } catch {
    state.error = "The local OpenAPI document could not be loaded. Confirm that Core is healthy and retry.";
  }
  render();
}

/** @param {Event} event */
function handleFilter(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || !target.dataset.filter) return;
  if (target.dataset.filter === "query") state.query = target.value;
  if (target.dataset.filter === "platform") state.platform = target.value;
  if (target.dataset.filter === "availability") state.availability = target.value;
  render();
  if (target.dataset.filter === "query") {
    const search = mount.querySelector('[data-filter="query"]');
    if (search instanceof HTMLElement) search.focus();
  }
}

/** @param {Event} event */
async function handleClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-operation],[data-action]") : null;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.operation) {
    state.activeOperationId = target.dataset.operation;
    render();
    mount.querySelector(".operation-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.dataset.action === "reload") return load();
  if (target.dataset.action === "copy-curl") {
    const form = target.closest("form");
    if (!(form instanceof HTMLFormElement)) return;
    const operation = findOperation(form.dataset.operationId ?? "");
    if (!operation) return;
    const curl = buildCurl(operation, formValues(form));
    const preview = form.querySelector("[data-curl-preview]");
    if (preview) preview.textContent = curl;
    await navigator.clipboard?.writeText(curl);
    target.textContent = "Copied";
  }
}

/** @param {SubmitEvent} event */
async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches("[data-request-builder]")) return;
  event.preventDefault();
  const operation = findOperation(form.dataset.operationId ?? "");
  if (!operation || operation.availability === "fixture_only") return;
  const values = formValues(form);
  if (operation.method !== "GET" && !confirm("Send this mutating request? Social writes are single-attempt. If the result is UNKNOWN, do not resubmit it.")) return;
  const result = form.querySelector("[data-request-result]");
  if (!(result instanceof HTMLElement)) return;
  result.hidden = false;
  result.innerHTML = "<p>Sending one request…</p>";
  try {
    const request = buildFetchRequest(operation, values);
    const response = await fetch(request.url, request.init);
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    result.replaceChildren(renderResponse(response.status, response.headers.get("x-request-id"), body));
  } catch {
    result.replaceChildren(renderResponse(0, null, { error: { code: "NETWORK_ERROR", message: "The local request did not complete." } }));
  }
}

/** @param {ReturnType<typeof findOperation> extends infer T ? Exclude<T,null> : never} operation @param {Record<string,string>} values */
function buildFetchRequest(operation, values) {
  let path = operation.path;
  for (const parameter of operation.parameters) {
    if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, encodeURIComponent(values[`path:${parameter.name}`] ?? ""));
  }
  const url = new URL(path, location.origin);
  for (const parameter of operation.parameters) {
    const value = values[`query:${parameter.name}`];
    if (parameter.in === "query" && value) url.searchParams.set(parameter.name, value);
  }
  const headers = new Headers({ accept: "application/json" });
  if (values.apiKey) headers.set("authorization", `Bearer ${values.apiKey}`);
  for (const parameter of operation.parameters) {
    const value = values[`header:${parameter.name}`];
    if (parameter.in === "header" && value) headers.set(parameter.name, value);
  }
  /** @type {RequestInit} */
  const init = { method: operation.method, headers, credentials: "same-origin" };
  if (operation.requestBody) {
    JSON.parse(values.body ?? "{}");
    headers.set("content-type", "application/json");
    init.body = values.body ?? "{}";
  }
  return { url, init };
}

/** @param {number} status @param {string|null} requestId @param {unknown} body */
function renderResponse(status, requestId, body) {
  const wrapper = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = status ? `HTTP ${status}` : "Request failed";
  wrapper.append(heading);
  if (requestId) { const correlation = document.createElement("span"); correlation.textContent = `Request ID: ${requestId}`; wrapper.append(correlation); }
  const pre = document.createElement("pre");
  pre.textContent = typeof body === "string" ? body : (JSON.stringify(body, null, 2) ?? "");
  wrapper.append(pre);
  return wrapper;
}

/** @param {HTMLFormElement} form */
function formValues(form) { return Object.fromEntries([...new FormData(form).entries()].map(([key, value]) => [key, String(value)])); }
/** @param {string} operationId */
function findOperation(operationId) { return flattenOperations(state.spec ?? {}).find((operation) => operation.operationId === operationId) ?? null; }
function render() { mount.innerHTML = renderExplorer(state); }
