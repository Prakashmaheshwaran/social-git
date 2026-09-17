import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore, MockRedditAdapter, SocialGitService } from "../src/index.ts";

export const allScopes = ["accounts:write", "accounts:read", "connections:write", "connections:read", "social:read", "social:write", "actions:read", "audit:read"];
export const principal = { callerId: "caller-a", scopes: allScopes };

export function tempDatabase() {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "social-git-test-"));
  return { root, path: join(root, "ledger.sqlite"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function fixture(options: { path?: string; identity?: string; recoverOnStart?: boolean } = {}) {
  const adapter = new MockRedditAdapter(options.identity ?? "native-user-1");
  const store = new LedgerStore(options.path ?? ":memory:");
  const service = new SocialGitService({ store, adapters: [adapter], recoverOnStart: options.recoverOnStart });
  const created = await service.createAccount(principal, { platform: "reddit", expectedNativeUserId: "native-user-1", label: "Primary" });
  const accountId = created.account.id;
  await service.importConnection(principal, accountId, { vaultHandle: "vault://fixture/session", generation: 1 });
  return { adapter, store, service, accountId };
}

export const writeRequests = [
  { kind: "text_post", subreddit: "test", title: "Text", text: "Body" },
  { kind: "link_post", subreddit: "test", title: "Link", url: "https://example.com/item" },
  { kind: "media_post", subreddit: "test", title: "Media", mediaRef: "media://object-1" },
  { kind: "comment", postId: "post-1", text: "Comment" },
  { kind: "reply", commentId: "comment-1", text: "Reply" },
  { kind: "edit", targetId: "post-owned-by-caller", text: "Edited body" },
  { kind: "vote", targetId: "post-1", direction: 1 },
  { kind: "save", targetId: "post-1" },
  { kind: "unsave", targetId: "post-1" },
  { kind: "subscribe", subreddit: "test" },
  { kind: "unsubscribe", subreddit: "test" },
  { kind: "delete", targetId: "post-owned-by-caller" },
] as const;
