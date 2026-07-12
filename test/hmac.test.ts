import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sign, verify, isFresh } from "../src/hmac.js";

// Fixed vector for the HMAC-SHA256(secret, "{timestampMs}.{callId}") hex-lower handshake the StandIn media bridge uses.
// Recompute independently here so a refactor of sign() can't silently drift.
test("sign matches the shared HMAC handshake recipe", () => {
  const secret = "test-secret";
  const ts = 1720000000000;
  const callId = "19:meeting_abc@thread.v2";
  const expected = createHmac("sha256", secret).update(`${ts}.${callId}`, "utf8").digest("hex");
  assert.equal(sign(secret, ts, callId), expected);
  assert.match(sign(secret, ts, callId), /^[0-9a-f]{64}$/);
});

test("verify accepts correct and rejects tampered signatures", () => {
  const secret = "s3cret";
  const ts = 1720000000000;
  const callId = "call-123";
  const sig = sign(secret, ts, callId);
  assert.equal(verify(secret, ts, callId, sig), true);
  assert.equal(verify(secret, ts, callId, sig.toUpperCase()), true); // hex signatures compare case-insensitively
  assert.equal(verify(secret, ts + 1, callId, sig), false);
  assert.equal(verify(secret, ts, "other-call", sig), false);
  assert.equal(verify("wrong", ts, callId, sig), false);
  assert.equal(verify(secret, ts, callId, ""), false);
});

test("isFresh enforces the replay window", () => {
  const now = 1720000000000;
  assert.equal(isFresh(now - 30_000, 60_000, now), true);
  assert.equal(isFresh(now + 30_000, 60_000, now), true);
  assert.equal(isFresh(now - 61_000, 60_000, now), false);
  assert.equal(isFresh(NaN, 60_000, now), false);
});
