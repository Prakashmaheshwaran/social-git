# Reddit private-messaging candidate

Status: direct-session worker candidate implemented and production-disabled. This work used no live Reddit
request, credential, browser-cookie extraction, or mutation.

Social Git exposes typed REST, OpenAPI, and MCP candidates for bounded inbox
reads, one message thread, send, and reply. A standard-HTTP, fixed-egress worker
implementation now parses strict bounded native `t4` shapes. It is reachable
only with a process-local test admission token that production composition does
not create and that cannot be enabled through environment or API input.

The Core-to-worker command channel uses its own 32-byte command key, mutually
authenticated HMAC envelopes, fresh request and response nonces, timestamps,
status/path/body context, exact request-nonce echo, replay rejection, bounded
bodies, and buffer wiping. The Reddit and X command keys use separate volumes
and Unix groups; neither worker receives Core data keys or the other worker's
command key.

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
also inspected as immutable shape evidence. Pinned inbox/message/mixins source
proves `/message/messages/{id}/`, `/api/compose`, `/api/comment`, `thing_id`,
and native `t4` reply shapes. Its recordings exercise the official OAuth API,
so this evidence supports a candidate parser but does not by itself admit the
direct owner-session production route.

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
rejects them before identity verification, provider execution, or action
enqueue. Tests may inject the unforgeable process-local candidate admission:
inbox/thread then execute through the fixed-egress direct-session worker;
reply first binds the parent to the authenticated identity and counterpart and
succeeds only on an exact returned native `t4` with the same parent; compose is
submitted once but always finishes `UNKNOWN` because its empty success envelope
contains no request-bound native evidence. It is never polled or retried.

## Exact remaining live-admission work

Production admission requires authorized, reproducible direct-session evidence
for all of the following:

1. Bind the expected owner identity to the exact direct-session account and
   route without exporting or logging credentials.
2. Capture bounded inbox and thread results, including empty, missing,
   challenge, authentication, rate-limit, and protocol-drift cases.
3. Prove that compose returns request-bound native `t4` evidence. A sent-folder
   readback is only correlation and cannot distinguish a concurrent identical
   send, so it is insufficient. Reply still requires authorized live proof of
   the pinned parent/counterpart/result shape.
4. Exercise exactly one durable write attempt and prove that an ambiguous
   post-submit failure becomes `UNKNOWN` and is never retried automatically.
5. Admit the exact reviewed source and license disposition, then refresh the
   immutable release metadata and security review for the resulting runtime.

Until every item is complete, the production behavior must remain fail-closed.
