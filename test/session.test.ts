import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import { buildStart } from "../src/cartesia.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentPort, LineInbound, LineSessionHandlers } from "../src/cartesia.js";

const cfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  cartesiaApiKey: "unused-in-tests",
  agentId: "agent-test-1",
  apiHost: "api.cartesia.ai",
  cartesiaVersion: "2025-04-16",
  voiceId: null,
  introduction: null,
  systemPrompt: null,
  ttsModel: null, // goodbye falls back to a goodbye_request custom event
  ttsVoiceId: null,
  ttsLanguage: "en",
  maxCallMinutes: 0,
  goodbyeText: "Time limit reached, goodbye!",
  goodbyeGraceMs: 8000,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  workerIdleTimeoutMs: 0,
  trustProxy: false,
  tlsCertPath: null,
  tlsKeyPath: null,
};

/** Fake Line agent: records what the bridge sends, lets tests push events/audio back. */
class FakeAgent implements AgentPort {
  isOpen = true;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  handlers!: LineSessionHandlers;

  sendStart(start: Record<string, unknown>): void {
    this.sent.push(start);
  }
  sendAudioChunk(b64: string): void {
    this.sent.push({ event: "media_input", audio: b64 });
  }
  sendDtmf(digit: string): void {
    this.sent.push({ event: "dtmf", dtmf: digit });
  }
  sendCustom(metadata: Record<string, unknown>): void {
    this.sent.push({ event: "custom", metadata });
  }
  close(): void {
    this.closed = true;
  }
  emit(msg: LineInbound): void {
    this.handlers.onMessage(msg);
  }
  emitAudio(b64: string): void {
    this.handlers.onAudio(b64);
  }
}

function makeConnector(fake: FakeAgent) {
  return async (_cfg: BridgeConfig, _log: unknown, handlers: LineSessionHandlers): Promise<AgentPort> => {
    fake.handlers = handlers;
    return fake;
  };
}

// shared server: default config (no overrides, no TTS)
const fakeAgent = new FakeAgent();
const server = startServer(cfg, makeConnector(fakeAgent));
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function workerHeaders(callId: string): Record<string, string> {
  const ts = Date.now();
  return { "X-StandIn-Timestamp": String(ts), "X-StandIn-Signature": sign(cfg.workerSharedSecret, ts, callId) };
}

function connectWorker(p: number, callId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/voice/msteams/stream/${callId}`, { headers: workerHeaders(callId) });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const b64 = (s: string): string => Buffer.from(s).toString("base64");

// ---- buildStart (unit) ----

test("buildStart: pcm_16000 pinned, overrides only when set, caller context always in metadata", () => {
  const bare = buildStart({
    streamId: "s1",
    voiceId: null,
    introduction: null,
    systemPrompt: null,
    caller: { callerName: "Alice", tenantId: "t-1", direction: "inbound" },
    callId: "call-1",
  });
  assert.equal(bare.event, "start");
  assert.equal(bare.stream_id, "s1");
  assert.deepEqual(bare.config, { input_format: "pcm_16000" });
  assert.equal(bare.agent, undefined, "no agent overrides unless configured - never clobber the deployed prompt");
  const meta = bare.metadata as Record<string, unknown>;
  assert.equal(meta.callerName, "Alice");
  assert.equal(meta.tenantId, "t-1");
  assert.equal(meta.direction, "inbound");
  assert.equal(meta.callId, "call-1");
  assert.equal(meta.from, "msteams");

  const full = buildStart({
    streamId: "s2",
    voiceId: "voice-9",
    introduction: "Hello, I am an AI assistant.",
    systemPrompt: "You are the Komaa receptionist.",
    caller: { callerName: "Bob", tenantId: "t-2", direction: "outbound" },
    callId: "call-2",
  });
  assert.equal((full.config as Record<string, unknown>).voice_id, "voice-9");
  const agent = full.agent as Record<string, string>;
  assert.equal(agent.introduction, "Hello, I am an AI assistant.");
  assert.ok(agent.system_prompt.startsWith("You are the Komaa receptionist."));
  assert.match(agent.system_prompt, /speaking with Bob \(tenant: t-2\) on an outbound Microsoft Teams call/);
});

// ---- relay behavior (e2e against the shared server) ----

test("start is sent on session.start; caller audio buffers until ack, then flushes in order and flows verbatim", async () => {
  const callId = "call-relay-1";
  fakeAgent.sent = [];
  const ws = await connectWorker(port, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  ws.send(
    JSON.stringify({
      type: "session.start",
      callId,
      threadId: "t",
      caller: { displayName: "Alice", tenantId: "tenant-1" },
      direction: "inbound",
    }),
  );
  const start = await until(() => fakeAgent.sent.find((m) => m.event === "start"));
  assert.deepEqual(start.config, { input_format: "pcm_16000" });
  assert.equal((start.metadata as Record<string, unknown>).callerName, "Alice");

  // pre-ack audio must be buffered, not sent
  ws.send(JSON.stringify({ type: "audio.frame", seq: 0, timestampMs: 0, payloadBase64: b64("one") }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 20, payloadBase64: b64("two") }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fakeAgent.sent.filter((m) => m.event === "media_input").length, 0, "no audio before ack");

  // junk audio.frame (no payload) must not become media:{payload:undefined}
  ws.send(JSON.stringify({ type: "audio.frame", seq: 99, timestampMs: 0 }));

  // ack -> buffered frames flush oldest-first, verbatim
  fakeAgent.emit({ event: "ack", stream_id: "s" });
  await until(() => (fakeAgent.sent.filter((m) => m.event === "media_input").length === 2 ? true : undefined));
  const flushed = fakeAgent.sent.filter((m) => m.event === "media_input").map((m) => m.audio);
  assert.deepEqual(flushed, [b64("one"), b64("two")]);

  // the ack also emits an initial-context snapshot (state that landed pre-ack
  // or in session.start must not be lost to the agent code)
  const snapshot = fakeAgent.sent.find(
    (m) => m.event === "custom" && (m.metadata as Record<string, unknown>).type === "call_context",
  );
  assert.ok(snapshot, "initial call_context snapshot after ack");
  assert.equal((snapshot!.metadata as Record<string, unknown>).participantCount, 1);
  assert.equal((snapshot!.metadata as Record<string, unknown>).recordingStatus, "unknown");

  // post-ack audio flows directly
  ws.send(JSON.stringify({ type: "audio.frame", seq: 2, timestampMs: 40, payloadBase64: b64("three") }));
  await until(() => (fakeAgent.sent.filter((m) => m.event === "media_input").length === 3 ? true : undefined));

  // agent audio -> worker, payload verbatim, timeline advances by decoded bytes
  const frame640 = Buffer.alloc(640, 7).toString("base64");
  fakeAgent.emitAudio(frame640);
  fakeAgent.emitAudio(frame640);
  await until(() => (received.filter((m) => m.type === "audio.frame").length === 2 ? true : undefined));
  const audio = received.filter((m) => m.type === "audio.frame");
  assert.equal(audio[0].payloadBase64, frame640);
  assert.equal(audio[0].timestampMs, 0);
  assert.equal(audio[1].timestampMs, 20, "640 bytes @ 16 kHz = 20 ms");

  // clear -> assistant.cancel (barge-in flush)
  fakeAgent.emit({ event: "clear" });
  const cancel = await until(() => received.find((m) => m.type === "assistant.cancel"));
  assert.equal(cancel.turnId, 0);

  // dtmf rides the wire natively
  ws.send(JSON.stringify({ type: "dtmf", digit: "5" }));
  const dtmf = await until(() => fakeAgent.sent.find((m) => m.event === "dtmf"));
  assert.equal(dtmf.dtmf, "5");

  // participants -> call_context custom event
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  ws.send(JSON.stringify({ type: "participants" })); // junk: no count - dropped
  const ctx = await until(() =>
    fakeAgent.sent.find((m) => m.event === "custom" && (m.metadata as Record<string, unknown>).participantCount === 3),
  );
  assert.match(String((ctx.metadata as Record<string, unknown>).note), /3 human participants/);

  // transfer_call and error events are survivable no-ops
  fakeAgent.emit({ event: "transfer_call", transfer: { target_phone_number: "+15551234567" } });
  fakeAgent.emit({ type: "error", status_code: 429, message: "concurrency limited" } as LineInbound);
  ws.send(JSON.stringify({ type: "ping", ts: 42 }));
  const pong = await until(() => received.find((m) => m.type === "pong"));
  assert.equal(pong.ts, 42, "call survives transfer_call and error events");

  // worker-side governor goodbye without TTS -> goodbye_request custom event
  ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye from the governor." }));
  const bye = await until(() =>
    fakeAgent.sent.find((m) => m.event === "custom" && (m.metadata as Record<string, unknown>).type === "goodbye_request"),
  );
  assert.equal((bye.metadata as Record<string, unknown>).text, "Goodbye from the governor.");
  // the flush cancel preceding the goodbye
  assert.ok(received.filter((m) => m.type === "assistant.cancel").length >= 2);

  ws.close();
  await until(() => (fakeAgent.closed ? true : undefined));
});

test("callId mismatch in session.start ends the call", async () => {
  const callId = "call-mismatch-1";
  const fake = new FakeAgent();
  const s = startServer({ ...cfg }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId: "some-other-call", threadId: "t", caller: {} }));
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "callid-mismatch");
  assert.equal(fake.sent.length, 0, "no start for a mismatched call");
});

test("connect failure ends the call with agent-unavailable", async () => {
  const s = startServer({ ...cfg }, async () => {
    throw new Error("token mint failed");
  });
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-nofail-1";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-unavailable");
});

test("agent overrides land in the start event when configured", async () => {
  const fake = new FakeAgent();
  const s = startServer(
    {
      ...cfg,
      voiceId: "voice-override-1",
      introduction: "Hi! Quick note: I am an AI assistant.",
      systemPrompt: "You are Komaa's receptionist.",
    },
    makeConnector(fake),
  );
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-override-1";
  const ws = await connectWorker(p, callId);
  ws.send(
    JSON.stringify({ type: "session.start", callId, threadId: "t", caller: { displayName: "Val", tenantId: "t-9" } }),
  );
  const start = await until(() => fake.sent.find((m) => m.event === "start"));
  assert.equal((start.config as Record<string, unknown>).voice_id, "voice-override-1");
  const agent = start.agent as Record<string, string>;
  assert.equal(agent.introduction, "Hi! Quick note: I am an AI assistant.");
  assert.match(agent.system_prompt, /^You are Komaa's receptionist\./);
  assert.match(agent.system_prompt, /speaking with Val \(tenant: t-9\)/);
  ws.close();
});

test("bridge-side governor: goodbye_request then session.end time-limit; agent audio flows until then", async () => {
  const fake = new FakeAgent();
  // ~60 ms limit, 20 ms grace -> teardown well under a second
  const s = startServer({ ...cfg, maxCallMinutes: 0.001, goodbyeGraceMs: 20 }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-governor-1";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  fake.emit({ event: "ack" });

  const bye = await until(() =>
    fake.sent.find((m) => m.event === "custom" && (m.metadata as Record<string, unknown>).type === "goodbye_request"),
  );
  assert.equal((bye.metadata as Record<string, unknown>).text, cfg.goodbyeText);
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "time-limit");
  await until(() => (fake.closed ? true : undefined));
});

test("deterministic TTS goodbye: exact text synthesized, agent muted, real duration honored", async () => {
  const fake = new FakeAgent();
  const s = startServer(
    { ...cfg, ttsModel: "sonic-2", ttsVoiceId: "voice-tts-1", goodbyeGraceMs: 50 },
    makeConnector(fake),
  );
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  // Mock the Sonic TTS REST call: 3200 bytes = 100 ms of 16 kHz PCM.
  const pcm = Buffer.alloc(3200, 3);
  const realFetch = globalThis.fetch;
  const ttsCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    ttsCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(pcm, { status: 200 });
  }) as typeof fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  const callId = "call-tts-1";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  fake.emit({ event: "ack" });

  ws.send(JSON.stringify({ type: "assistant.say", text: "Thanks for calling, goodbye!" }));
  // 3200 bytes in 640-byte frames = 5 goodbye audio frames
  await until(() => (received.filter((m) => m.type === "audio.frame").length === 5 ? true : undefined));

  // the synth call carried the exact text and the wire format
  assert.equal(ttsCalls.length, 1);
  assert.match(ttsCalls[0].url, /\/tts\/bytes$/);
  assert.equal(ttsCalls[0].body.transcript, "Thanks for calling, goodbye!");
  assert.equal(ttsCalls[0].body.model_id, "sonic-2");
  assert.deepEqual(ttsCalls[0].body.voice, { mode: "id", id: "voice-tts-1" });
  assert.deepEqual(ttsCalls[0].body.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 });

  // agent audio is hard-muted while the deterministic goodbye plays
  const before = received.filter((m) => m.type === "audio.frame").length;
  fake.emitAudio(Buffer.alloc(640, 9).toString("base64"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.filter((m) => m.type === "audio.frame").length, before, "muted agent frame not relayed");

  // no goodbye_request fallback on the TTS path
  assert.equal(
    fake.sent.filter((m) => m.event === "custom" && (m.metadata as Record<string, unknown>).type === "goodbye_request").length,
    0,
  );
  ws.close();
});

test("duplicate session.start is ignored (no second Line stream)", async () => {
  const fake = new FakeAgent();
  let connects = 0;
  const s = startServer({ ...cfg }, async (_c, _l, handlers) => {
    connects++;
    fake.handlers = handlers;
    return fake;
  });
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-dupstart-1";
  const ws = await connectWorker(p, callId);
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(connects, 1, "second session.start must not dial Cartesia again");
  assert.equal(fake.sent.filter((m) => m.event === "start").length, 1);
  ws.close();
});

test("agent socket close ends the call cleanly", async () => {
  const fake = new FakeAgent();
  const s = startServer({ ...cfg }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-agentclose-1";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  fake.handlers.onClose(1000, "agent hung up");
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-disconnected");
});


test("embedder drain: server.drain() ends live calls gracefully without exiting", async () => {
  const fake = new FakeAgent();
  const s = startServer({ ...cfg }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-drain-1";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  fake.emit({ event: "ack" });

  await s.drain("bridge-shutdown");
  const end = received.find((m) => m.type === "session.end");
  assert.ok(end, "worker told the call is ending");
  assert.equal(end!.reason, "bridge-shutdown");
  assert.equal(fake.closed, true, "agent stream closed");
  // no process.exit involved: the listener is still up until the embedder closes it
  const ws2 = await connectWorker(p, "call-drain-2");
  ws2.close();
});

test("a Cartesia error before the ack fails the call fast; after the ack it is advisory", async () => {
  const fake = new FakeAgent();
  const s = startServer({ ...cfg }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-preack-err";
  const ws = await connectWorker(p, callId);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  // error BEFORE ack: the stream never came up - fail now, not at the 10s timeout
  fake.emit({ type: "error", status_code: 404, message: "agent not found" } as LineInbound);
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-error");

  // post-ack error is advisory: the call survives
  const fake2 = new FakeAgent();
  const s2 = startServer({ ...cfg }, makeConnector(fake2));
  await new Promise<void>((r) => s2.once("listening", () => r()));
  const p2 = (s2.address() as AddressInfo).port;
  after(() => s2.close());
  const ws2 = await connectWorker(p2, "call-postack-err");
  ws2.send(JSON.stringify({ type: "session.start", callId: "call-postack-err", threadId: "t", caller: {} }));
  await until(() => fake2.sent.find((m) => m.event === "start"));
  fake2.emit({ event: "ack" });
  fake2.emit({ type: "error", status_code: 429, message: "transient" } as LineInbound);
  ws2.send(JSON.stringify({ type: "ping", ts: 1 }));
  const received2: Array<Record<string, unknown>> = [];
  ws2.on("message", (d) => received2.push(JSON.parse(d.toString())));
  await until(() => received2.find((m) => m.type === "pong"));
  ws2.close();
});

test("junk recording.status and zero participants are sanitized, not relayed", async () => {
  const fake = new FakeAgent();
  const s = startServer({ ...cfg }, makeConnector(fake));
  await new Promise<void>((r) => s.once("listening", () => r()));
  const p = (s.address() as AddressInfo).port;
  after(() => s.close());

  const callId = "call-sanitize-1";
  const ws = await connectWorker(p, callId);
  ws.send(JSON.stringify({ type: "session.start", callId, threadId: "t", caller: {} }));
  await until(() => fake.sent.find((m) => m.event === "start"));
  fake.emit({ event: "ack" });

  ws.send(JSON.stringify({ type: "recording.status" })); // no status field
  ws.send(JSON.stringify({ type: "participants", count: 0 }));
  ws.send(JSON.stringify({ type: "ping", ts: 9 }));
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  await until(() => received.find((m) => m.type === "pong"));

  const contexts = fake.sent
    .filter((m) => m.event === "custom")
    .map((m) => m.metadata as Record<string, unknown>)
    .filter((md) => md.type === "call_context");
  assert.ok(contexts.every((md) => md.recordingStatus !== "undefined"), "no literal 'undefined' status");
  assert.ok(contexts.some((md) => md.recordingStatus === "unknown"), "missing status becomes 'unknown'");
  assert.ok(contexts.every((md) => md.participantCount !== 0), "zero participant count dropped");
  ws.close();
});

// ---------------------------------------------------------------------------
// Upgrade-path lifecycle: an abrupt peer disconnect mid-handshake must be
// absorbed quietly, and the server must keep answering afterwards.
// ---------------------------------------------------------------------------
test("upgrade: abrupt peer disconnect during reject is tolerated; server stays live", async () => {
  const srv = startServer({ ...cfg });
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;

  const RAW_UPGRADE =
    "GET /voice/msteams/stream/call-tidy HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Connection: Upgrade\r\n" +
    "Upgrade: websocket\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n";

  // Unauthenticated upgrade, then drop the socket immediately: the reject write
  // races the closed socket and must be absorbed.
  await new Promise<void>((resolve) => {
    const s = net.connect(p, "127.0.0.1", () => {
      s.write(RAW_UPGRADE, () => {
        s.destroy();
        resolve();
      });
    });
    s.on("error", () => resolve());
  });
  await new Promise<void>((r) => setTimeout(r, 100));

  // Liveness: the same request, read to completion, still gets the 401 reject.
  const reply = await new Promise<string>((resolve) => {
    let buf = "";
    const s = net.connect(p, "127.0.0.1", () => s.write(RAW_UPGRADE));
    s.on("data", (d) => {
      buf += d.toString();
    });
    s.on("close", () => resolve(buf));
    s.on("error", () => resolve(buf));
    setTimeout(() => {
      s.destroy();
      resolve(buf);
    }, 1500);
  });
  assert.match(reply, /401/);
  srv.close();
});
