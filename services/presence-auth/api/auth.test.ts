import assert from "node:assert/strict";
import { test } from "node:test";
import handler, { capabilityFor, TOKEN_TTL_MS } from "./auth.ts";
import type { RealtimeContext, StreamGrant } from "./auth.ts";
const owner = "00000000-0000-4000-8000-000000000001";
const viewer = "00000000-0000-4000-8000-000000000002";
const stranger = "00000000-0000-4000-8000-000000000003";
const grant: StreamGrant = { owner_id: owner, viewer_id: viewer, stream_id: crypto.randomUUID(),
  grant_id: crypto.randomUUID(), session_id: crypto.randomUUID(), allow_input: false,
  expires_at: new Date(Date.now() + 3_600_000).toISOString() };
function context(id = owner): RealtimeContext {
  const peers = [{ id: owner, handle: "owner", presence_sharing: true }, { id: viewer, handle: "viewer", presence_sharing: false }];
  return { identity: peers.find(p => p.id === id)!, peers, streams: [grant] };
}
test("no wildcard, global presence or legacy namespace grants", () => {
  const cap = capabilityFor(context());
  assert.ok(Object.keys(cap).every(k => !k.includes("*") && !k.startsWith("clarence:") && k !== "flock:presence"));
  assert.equal(cap[`flock:presence:${viewer}`], undefined);
  assert.equal(TOKEN_TTL_MS, 60_000);
});
test("owner can publish output only; observe viewer cannot publish output or input", () => {
  const name = `flock:stream:${grant.grant_id}`;
  assert.deepEqual(capabilityFor(context())[`${name}:output`], ["publish"]);
  const cap = capabilityFor(context(viewer));
  assert.deepEqual(cap[`${name}:output`], ["subscribe"]);
  assert.deepEqual(cap[`${name}:control`], ["publish"]);
  assert.equal(cap[`${name}:input`], undefined);
});
test("copilot grants input in only the viewer-to-owner direction", () => {
  for (const id of [owner, viewer]) {
    const ctx = context(id); ctx.streams = [{ ...grant, allow_input: true }];
    assert.deepEqual(capabilityFor(ctx)[`flock:stream:${grant.grant_id}:input`], [id === owner ? "subscribe" : "publish"]);
  }
});
test("rejects nonmember, malformed, expired and nonfriend stream contexts", () => {
  for (const change of [{ owner_id: stranger }, { grant_id: "*" }, { expires_at: "bad" }, { expires_at: "2000-01-01" }]) {
    const ctx = context(); ctx.streams = [{ ...grant, ...change }];
    assert.throws(() => capabilityFor(ctx));
  }
  const ctx = context(); ctx.peers = [ctx.identity];
  assert.throws(() => capabilityFor(ctx));
});
test("empty grants mean no stream capabilities", () => {
  const ctx = context(); ctx.streams = [];
  assert.ok(Object.keys(capabilityFor(ctx)).every(k => !k.startsWith("flock:stream:")));
});
test("client-selected streams and legacy tokens fail before upstream requests", async () => {
  for (const body of [{ token: "gho_legacy" }, { token: "a.validlength.token", streams: [] }, { token: [] }]) {
    let status = 200;
    const res = { status(n: number) { status = n; return this; }, json() {}, end() {}, setHeader() {} };
    await handler({ method: "POST", body }, res);
    assert.equal(status, 400);
  }
});
