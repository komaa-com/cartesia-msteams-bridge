import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerMessage, pcm16kBytesToMs } from "../src/protocol.js";

test("parses a worker audio.frame (camelCase, discriminated on type)", () => {
  const raw = JSON.stringify({
    type: "audio.frame",
    seq: 42,
    timestampMs: 840,
    payloadBase64: "AAAA",
  });
  const msg = parseWorkerMessage(raw);
  assert.ok(msg && msg.type === "audio.frame");
  assert.equal(msg.seq, 42);
  assert.equal(msg.payloadBase64, "AAAA");
});

test("parses session.start with nullable caller fields", () => {
  const raw = JSON.stringify({
    type: "session.start",
    callId: "c1",
    threadId: "t1",
    caller: { aadId: null, displayName: null, tenantId: null },
  });
  const msg = parseWorkerMessage(raw);
  assert.ok(msg && msg.type === "session.start");
  assert.equal(msg.caller.displayName, null);
});

test("returns null on junk instead of throwing", () => {
  assert.equal(parseWorkerMessage("not json"), null);
  assert.equal(parseWorkerMessage("42"), null);
  assert.equal(parseWorkerMessage(JSON.stringify({ noType: true })), null);
});

test("pcm16k duration math: 640 bytes = one 20ms frame", () => {
  assert.equal(pcm16kBytesToMs(640), 20);
  assert.equal(pcm16kBytesToMs(32_000), 1000);
});
