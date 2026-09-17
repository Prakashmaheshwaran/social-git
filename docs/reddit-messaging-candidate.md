# Reddit private-messaging candidate

Status: fixture-complete and production-disabled. This work used no live Reddit
request, credential, browser-cookie extraction, or mutation.

Social Git exposes typed REST, OpenAPI, and MCP candidates for bounded inbox
reads, one message thread, send, and reply. Production rejects every candidate
before a direct-session request or durable submission boundary. The candidates
exist so the public contract, normalized DTOs, idempotency model, failure model,
and UI capability discovery can be reviewed without representing unproved
protocol behavior as live compatibility.

## Exact evidence reviewed

The primary evidence is `reddit-lyr` 0.1.1 at commit
`87ec32aff905923ecd156e7951c168adfdf6fac1`. The pinned source review found:

- `reddit_mcp_server/scraping/api_client.py` maps inbox folders to
  `/message/{where}.json` and compose to `/api/compose`.
- `reddit_mcp_server/scraping/normalizer.py` identifies the bounded message
  fields used by the candidate DTOs.
- `reddit_mcp_server/tools/messaging.py` discards the compose response and
  constructs a synthetic success object. It therefore cannot prove a native
  message ID, destination, or canonical result.

PRAW 8.0.3 at commit `fdc29bb103ad652eea6740c77c2be099d1c1357e` was
also inspected as secondary shape evidence. Its recordings exercise the
official OAuth API, so they do not admit a direct owner-session production
route in Social Git.

## Public candidate contract

| Candidate | REST | MCP | Fixture | Production |
| --- | --- | --- | --- | --- |
| Inbox | `GET /v1/accounts/{accountId}/reddit/messages` | `reddit_message_inbox_list` | Enabled | Disabled |
| Thread | `GET /v1/accounts/{accountId}/reddit/messages/{messageId}` | `reddit_message_thread_get` | Enabled | Disabled |
| Send / reply | `POST /v1/accounts/{accountId}/reddit/messages/actions` | `reddit_message_action_create` | Enabled | Disabled |

Inputs are allowlisted and bounded. Message fullnames must be `t4` identifiers;
recipients, subjects, bodies, folders, cursors, and limits have explicit
validation. Results expose normalized message fields only. Session material
remains in Core custody and is never part of these contracts.

Fixture writes use the ordinary durable, caller-scoped idempotency contract.
A fixture worker exit after its submission event produces terminal `UNKNOWN`
with `retryPermitted: false`; replaying the same idempotency key cannot submit
again.

## Machine-readable production gates

Capability discovery reports these exact reasons:

- `message.inbox`: `AUTHORIZED_LIVE_INBOX_PROOF_MISSING`
- `message.thread`: `DIRECT_SESSION_THREAD_MAPPING_UNPROVEN`
- `message.send`: `NO_VERIFIABLE_NATIVE_RESULT`
- `message.reply`: `DIRECT_SESSION_REPLY_MAPPING_UNPROVEN`

Production excludes these operations from the executable capability set and
rejects them before provider execution or action enqueue.

## Exact remaining live-admission work

Production admission requires authorized, reproducible direct-session evidence
for all of the following:

1. Bind the expected owner identity to the exact direct-session account and
   route without exporting or logging credentials.
2. Capture bounded inbox and thread results, including empty, missing,
   challenge, authentication, rate-limit, and protocol-drift cases.
3. Prove that send and reply return a verifiable native `t4` result bound to the
   requested recipient or parent. A synthetic or empty success is insufficient.
4. Exercise exactly one durable write attempt and prove that an ambiguous
   post-submit failure becomes `UNKNOWN` and is never retried automatically.
5. Admit the exact reviewed source and license disposition, then refresh the
   immutable release metadata and security review for the resulting runtime.

Until every item is complete, the production behavior must remain fail-closed.
