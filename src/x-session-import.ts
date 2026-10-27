import {
  boundedSessionText,
  createOwnerSessionImportController,
  exactSessionObject,
  type OwnerSessionImportMaterial,
} from "./owner-session-import.ts";
import { ServiceError } from "./errors.ts";
import type { SocialGitService } from "./service.ts";

const PATH = /^\/v1\/control-plane\/accounts\/([^/]+)\/x-session$/u;
const KEYS = ["platform", "expectedNativeUserId", "auth_token", "ct0"] as const;

/**
 * Browser-only secret-ingest boundary for an explicitly exported X session.
 * The shared factory owns the same-origin, owner-cookie, CSRF, size, and wipe
 * guarantees; this module owns only the X export schema.
 *
 * Core decides whether the generation may be verified. This controller never
 * chooses the status: the import callback reports 202 while the transport is
 * unadmitted, and 201 once an admitted adapter verifies the generation.
 */
export const OwnerXSessionImportController = createOwnerSessionImportController<SocialGitService>({
  path: PATH,
  platformLabel: "X",
  schema: { parse: parseXSession },
  async importSession(service, owner, accountId, material) {
    const result = await service.importOwnerXSession(owner, accountId, material);
    return { status: result.admission.state === "verified" ? 201 : 202, body: result };
  },
});

export type OwnerXSessionImportController = InstanceType<typeof OwnerXSessionImportController>;

export function parseXSession(parsed: unknown): OwnerSessionImportMaterial {
  const body = exactSessionObject(parsed, "X", KEYS);
  if (body.platform !== "x") throw new ServiceError("VALIDATION_FAILED", "The session file must use the X session export schema.");
  const expectedNativeUserId = boundedSessionText(body.expectedNativeUserId, "expectedNativeUserId", 128, /^\d{1,128}$/u);
  const authToken = boundedSessionText(body.auth_token, "auth_token", 8192, /^[^;\s\0\r\n]+$/u);
  const csrfToken = boundedSessionText(body.ct0, "ct0", 8192, /^[^;\s\0\r\n]+$/u);
  const session = Buffer.from(JSON.stringify({ cookies: { auth_token: authToken, ct0: csrfToken } }), "utf8");
  const route = Buffer.from(JSON.stringify({ kind: "direct" }), "utf8");
  return { expectedNativeUserId, session, networkRoute: { id: "x-direct", material: route } };
}
