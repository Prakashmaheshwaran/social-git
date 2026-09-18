#!/usr/bin/env node

import { once } from "node:events";
import { ProductionXCommandDispatcher, evaluateCommittedXRuntimeAdmission } from "./runtime-x.ts";
import { createXWorkerHttpServer } from "./x-worker-http.ts";
import { readXCommandKeyFile } from "./x-ipc-auth.ts";
import { loadAdmissionEnvelope } from "./admission-envelope.ts";
import { CertificationOnlyXDispatcher } from "./x-certification.ts";
import { liveTestGrantFingerprint } from "@social-git/security";

const host = process.env.SOCIAL_GIT_HOST ?? "0.0.0.0";
const port = boundedPort(process.env.SOCIAL_GIT_PORT ?? "8082");
const productAdmission = evaluateCommittedXRuntimeAdmission(operatorRequested(process.env.SOCIAL_GIT_X_TRANSPORT_ENABLED));
const certificationPaths = [process.env.SOCIAL_GIT_ADMISSION_ENVELOPE_FILE, process.env.SOCIAL_GIT_ADMISSION_QA_PUBLIC_KEY_FILE, process.env.SOCIAL_GIT_ADMISSION_APPROVER_PUBLIC_KEY_FILE];
if (certificationPaths.some(Boolean) && !certificationPaths.every(Boolean)) throw new TypeError("X certification worker requires the signed envelope and both approval public keys");
const certified = certificationPaths.every(Boolean) ? loadAdmissionEnvelope({
  envelopePath: certificationPaths[0]!, qaPublicKeyPath: certificationPaths[1]!, approverPublicKeyPath: certificationPaths[2]!, releaseMetadataDirectory: "/opt/social-git/share",
}) : undefined;
const xCertified = certified?.grant.platform === "x" ? certified : undefined;
const admission = xCertified ? Object.freeze({ requested: false, enabled: true, productionEnabled: false, disabledReasons: productAdmission.disabledReasons, certificationOnly: true, certification: Object.freeze({ grantFingerprint: liveTestGrantFingerprint(xCertified.grant), sourceCommit: xCertified.sourceCommit, deploymentId: xCertified.deploymentId, evidenceKeyFingerprint: xCertified.evidenceKeyFingerprint }) }) : productAdmission;
const baseDispatcher = admission.enabled ? new ProductionXCommandDispatcher({ admission }) : undefined;
const dispatcher = xCertified && baseDispatcher
  ? new CertificationOnlyXDispatcher(baseDispatcher, xCertified, required(process.env.SOCIAL_GIT_X_CERTIFICATION_DATABASE, "SOCIAL_GIT_X_CERTIFICATION_DATABASE"))
  : baseDispatcher;
const commandKey = admission.enabled ? readXCommandKeyFile(required(process.env.SOCIAL_GIT_X_COMMAND_KEY_FILE, "SOCIAL_GIT_X_COMMAND_KEY_FILE")) : undefined;
const server = createXWorkerHttpServer({ admission, ...(dispatcher && commandKey ? { dispatcher, commandKey } : {}) });
commandKey?.fill(0);

server.listen(port, host);
await Promise.race([once(server, "listening"), once(server, "error").then(([error]) => Promise.reject(error))]);
process.stdout.write(`${JSON.stringify({ level: "info", message: xCertified ? "x_worker.certification_only_ready" : admission.enabled ? "x_worker.ready" : "x_worker.candidate_ready_production_disabled", host, port, disabledReasons: admission.disabledReasons })}\n`);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { if (stopping) return; stopping = true; server.beginShutdown(); server.close(() => { process.exitCode = 0; }); });

function boundedPort(value: string) { if (!/^\d+$/u.test(value)) throw new TypeError("X worker port must be an integer"); const port = Number(value); if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("X worker port is out of range"); return port; }
function operatorRequested(value: string | undefined) { if (value === undefined || value === "false") return false; if (value === "true") return true; throw new TypeError("SOCIAL_GIT_X_TRANSPORT_ENABLED must be true or false"); }
function required(value: string | undefined, name: string) { if (!value) throw new TypeError(`${name} is required`); return value; }
