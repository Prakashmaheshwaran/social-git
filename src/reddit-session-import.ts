import {
  boundedSessionText,
  createOwnerSessionImportController,
  exactSessionObject,
  type OwnerSessionImportMaterial,
} from "./owner-session-import.ts";
import { ServiceError } from "./errors.ts";
import type { SocialGitService } from "./service.ts";

const PATH = /^\/v1\/control-plane\/accounts\/([^/]+)\/reddit-session$/u;
const KEYS = ["version", "platform", "expectedNativeUserId", "redditSessionCookie", "csrfToken"] as const;

/**
 * Browser-only secret-ingest boundary for an explicitly exported Reddit
 * session. The shared factory owns the same-origin, owner-cookie, CSRF, size,
 * and wipe guarantees; this module owns only the Reddit v1 export schema.
 */
export const OwnerRedditSessionImportController = createOwnerSessionImportController<SocialGitService>({
  path: PATH,
  platformLabel: "Reddit",
  schema: { parse: parseRedditSession },
  async importSession(service, owner, accountId, material) {
    const result = await service.importOwnerRedditSession(owner, accountId, material);
    return { status: 201, body: result };
  },
});

export type OwnerRedditSessionImportController = InstanceType<typeof OwnerRedditSessionImportController>;

export function parseRedditSession(parsed: unknown): OwnerSessionImportMaterial {
  const body = exactSessionObject(parsed, "Reddit", KEYS);
  if (body.version !== 1 || body.platform !== "reddit") {
    throw new ServiceError("VALIDATION_FAILED", "The session file must use the Reddit session export v1 schema.");
  }
  const expectedNativeUserId = boundedSessionText(body.expectedNativeUserId, "expectedNativeUserId", 128, /^[A-Za-z0-9_:.-]+$/u);
  const redditSessionCookie = boundedSessionText(body.redditSessionCookie, "redditSessionCookie", 8192, /^[^;\s\0\r\n]+$/u);
  const csrfToken = boundedSessionText(body.csrfToken, "csrfToken", 4096, /^[^\s\0\r\n]+$/u);
  const session = Buffer.from(JSON.stringify({ cookies: { reddit_session: redditSessionCookie }, csrfToken }), "utf8");
  const route = Buffer.from(JSON.stringify({ kind: "direct" }), "utf8");
  return { expectedNativeUserId, session, networkRoute: { id: "reddit-direct", material: route } };
}
