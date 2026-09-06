# Social data and deployment

Migration `013_social_privacy.sql`, the presence auth service and the matching desktop client are one protocol upgrade. Do not deploy the client against the old auth endpoint. There is deliberately no fallback to wildcard terminal permissions.

## Deployment order

1. Back up the database and apply numbered migrations through `013_social_privacy.sql` in a transaction using the normal migration administrator. New installations apply `schema.sql`, then the numbered migrations in order. Historical migrations describe prior behavior; 013 supersedes the old usage policies and signup trigger.
2. Deploy the new presence auth service with `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `ABLY_API_KEY`. It calls `realtime_context` with the user's token, never a service-role bypass. Missing migrations, invalid identities and upstream failures deny authorization.
3. Stop old wildcard token issuance. Revoke existing legacy tokens using Ably's supported revocation controls, or wait at least the old maximum lifetime (one hour) after disabling every old issuer. Existing wildcard tokens must be gone before new terminal sharing is enabled. Test the actual Ably key and project settings in staging; this repository does not configure the live account. Ensure the key permits the explicit new channel capabilities, and disable message persistence/history on the `flock:*` channel rules.
4. Distribute the matching desktop release. Older builds cannot join its private channels. Test two accepted accounts and one unrelated account: observe, copilot, ending, removing a friendship, changing a handle, reconnecting, and revoking each privacy option.

The source tests do not establish that a production database, Ably account or Vercel deployment has been updated. Do not roll back the service to blanket grants to restore old-client compatibility.

## Defaults and consent

Both usage sharing and online status default to **off**, including existing accounts. Settings → Account → Privacy contains independent choices. New signups get no founder friendship; an email invitation creates a pending request that the recipient must accept. Existing friendships remain because earlier founder backfills were indistinguishable from ordinary accepted relationships. The privacy controls explain this and point users to their friend list before sharing.

Usage sharing uploads prompt, launched-agent and created-workspace counts, cumulative Claude Code token/cost estimates and daily cumulative snapshots to Supabase. The Claude scan is machine-wide for the OS user, including sessions outside flock. It does not upload prompt/transcript text. The option authorizes both upload and visibility to accepted friends. Pending requests, strangers and anonymous clients cannot read usage. Legacy clients cannot upload while consent is off.

Disabling usage stops scanning/uploading, drops pending deltas and deletes the account's uploaded totals and daily history in one server transaction. In-flight writes serialize with revocation. Existing historical usage remains private until the user enables sharing or disables/deletes it using the explicit “Delete synced usage and stop sharing” control. While enabled, data is retained until disabled or the account is deleted; the client does not automatically expire daily rows. Authentication/profile data, invitations and friendships remain after sign-out. Operators delete accounts through Supabase Auth when requested; linked profiles, usage and stream records cascade on account deletion. Operators must document their own backup deletion schedule; live backup retention is outside this repository.

Online status sends the account UUID, window UUID and running-agent count to an account-specific Ably presence channel. Only that account can enter it; accepted friends can subscribe only while its presence consent is enabled. There is no global presence directory. Disabling leaves the channel; previously issued permissions expire within 60 seconds. Removing a friendship also removes inbox and presence access at the next token issuance.

## Terminal sharing

Sharing requires an explicit owner action and an accepted friendship (or the same account across windows). The server binds each stream to immutable owner/viewer UUIDs. Clients cannot request arbitrary stream IDs in an auth request. A server-generated generation UUID identifies three distinct Ably channels: owner output, viewer ready/control, and optional copilot input. Observe viewers never receive input capabilities. Clients verify Ably-stamped publisher UUIDs in addition to channel permissions. Terminal output may contain secrets; sharing a pane intentionally transmits that output to the chosen participant. Copilot also grants that participant typing access.

Grants expire after eight hours; tokens expire after 60 seconds and refresh membership frequently. Ending a session stops local streaming/input immediately and revokes its server grants. Removing a friendship permanently revokes its grants. Reopening requires owner authorization and generates new channels; re-adding a friend cannot resurrect an old session. A noncompliant remote client may keep already-issued capabilities until token expiry, but the local owner stops emitting/accepting bytes on end. If the revocation network request fails, local sharing still stops; server grants remain until a later revocation or their eight-hour expiry. Offline revocation cannot erase output the participant already received.

Supabase stores grant IDs, participant IDs, permission, session/stream IDs and expiry/revocation timestamps, not terminal bytes. Expired/revoked metadata is currently retained until account deletion or administrator cleanup. Ably carries output/input and directed session messages (including task prompts); Flock requests no message history capability. Operators must review provider channel persistence and operational log retention rather than assuming transport implies zero retention. Never log access tokens, token responses or terminal payloads.

## Verification

- `python3 services/flock-id/tests/run.py` creates and removes its own isolated Docker PostgreSQL container; it never uses a developer or production database.
- `cd services/presence-auth && npm test && npm run check`
- `cd apps/flock-desktop && npx vitest run src/lib/usageStats.test.ts src/lib/streamPublisher.test.ts src/lib/session.test.ts --maxWorkers=2`

Ably capability and renewal contracts: [token authentication](https://ably.com/docs/auth/token), [TokenRequest specification](https://ably.com/docs/api/token-request-spec). The one-minute lifetime favors a tight revocation window over Ably's longer recommended renewal interval; monitor auth-service traffic and do not silently relax it.
