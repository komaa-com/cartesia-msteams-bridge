import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { ReplayGuard, authorizeUpgrade, callIdFromUrl } from "../src/server.js";
import { sign, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "../src/hmac.js";
import { loadConfig, type BridgeConfig } from "../src/config.js";

const SECRET = "test-secret";

const baseCfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: SECRET,
  cartesiaApiKey: "x",
  agentId: "agent-test-1",
  apiHost: "api.cartesia.ai",
  cartesiaVersion: "2025-04-16",
  voiceId: null,
  introduction: null,
  systemPrompt: null,
  ttsModel: null,
  ttsVoiceId: null,
  ttsLanguage: "en",
  maxCallMinutes: 0,
  goodbyeText: "bye",
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

function req(callId: string, ts: number, sig: string): IncomingMessage {
  return {
    url: `/voice/msteams/stream/${callId}`,
    headers: { [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: sig },
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as IncomingMessage;
}

test("ReplayGuard: a verified tuple is single-use within the window", () => {
  const g = new ReplayGuard(60_000);
  const now = 1_000_000;
  const ts = now - 1_000; // fresh: within the 60s window of `now`
  assert.equal(g.claim("callA", ts, "sigA", now), true, "first use accepted");
  assert.equal(g.claim("callA", ts, "sigA", now), false, "replay rejected");
  assert.equal(g.claim("callA", ts + 1, "sigA", now), true, "different ts is a different tuple");
});

test("ReplayGuard: records expire once the timestamp is no longer fresh", () => {
  const g = new ReplayGuard(60_000);
  const t0 = 1_000_000;
  assert.equal(g.claim("callB", t0, "sigB", t0), true);
  // advance well past t0 + window: the old record is swept when the next claim runs
  const later = t0 + 120_000;
  assert.equal(g.claim("callC", later, "sigC", later), true);
  assert.equal(g.size, 1, "expired entry swept");
});

test("authorizeUpgrade: replays are rejected even with a valid signature", () => {
  const g = new ReplayGuard(60_000);
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callD");
  assert.deepEqual(authorizeUpgrade(baseCfg, req("callD", ts, sig), g), { callId: "callD" });
  const second = authorizeUpgrade(baseCfg, req("callD", ts, sig), g);
  assert.ok("error" in second && /replay/i.test(second.error), "second identical upgrade is a replay");
});

test("authorizeUpgrade: fail-closed on an empty shared secret", () => {
  const ts = Date.now();
  const sig = sign(SECRET, ts, "callE");
  const res = authorizeUpgrade({ ...baseCfg, workerSharedSecret: "" }, req("callE", ts, sig));
  assert.ok("error" in res && /not configured/.test(res.error), "empty secret rejects all");
});

test("Cartesia host is restricted to cartesia.ai (API-key exfil guard)", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = SECRET;
    process.env.CARTESIA_API_KEY = "sk_car_x";
    process.env.CARTESIA_AGENT_ID = "agent-1";

    process.env.CARTESIA_API_HOST = "api.cartesia.ai";
    assert.equal(loadConfig().apiHost, "api.cartesia.ai", "default host allowed");

    process.env.CARTESIA_API_HOST = "evil.example.com";
    assert.throws(() => loadConfig(), /not a cartesia\.ai host/, "arbitrary host rejected");

    process.env.CARTESIA_HOST_ALLOW_ANY = "true";
    assert.equal(loadConfig().apiHost, "evil.example.com", "explicit override honored");
  } finally {
    process.env = saved;
  }
});

// A malformed percent-escape in the upgrade path must NOT throw (that would be
// an uncaught exception -> process crash, pre-auth).
test("callIdFromUrl returns null for a malformed percent-escape (no throw)", () => {
  assert.equal(callIdFromUrl("/voice/msteams/stream/%zz"), null);
  assert.equal(callIdFromUrl("/%E0%A4%A"), null); // truncated escape
  assert.equal(callIdFromUrl("/voice/stream/call%20123"), "call 123"); // valid still decodes
});

test("authorizeUpgrade rejects a malformed-escape URL instead of throwing", () => {
  const badReq = { url: "/voice/msteams/stream/%zz", headers: {}, socket: {} } as unknown as IncomingMessage;
  const res = authorizeUpgrade({ ...baseCfg, workerSharedSecret: SECRET }, badReq, new ReplayGuard(60_000));
  assert.ok("error" in res && res.error === "no callId in path");
});

// Fail-loud on negative numerics (a typo like MAX_CALL_MINUTES=-1 would otherwise
// pass Number.isFinite and silently disable the governor).
test("loadConfig throws on a negative MAX_CALL_MINUTES", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.CARTESIA_API_KEY = "k";
    process.env.CARTESIA_AGENT_ID = "a";
    process.env.MAX_CALL_MINUTES = "-1";
    assert.throws(() => loadConfig(), /MAX_CALL_MINUTES.*must not be negative/);
  } finally {
    process.env = saved;
  }
});

// HMAC_FRESHNESS_MS=0 passes the non-negative check but would reject every
// upgrade AND disable replay protection - a misconfig that must fail loud.
test("loadConfig throws on HMAC_FRESHNESS_MS=0", () => {
  const saved = { ...process.env };
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.CARTESIA_API_KEY = "k";
    process.env.CARTESIA_AGENT_ID = "a";
    process.env.HMAC_FRESHNESS_MS = "0";
    assert.throws(() => loadConfig(), /HMAC_FRESHNESS_MS must be positive/);
  } finally {
    process.env = saved;
  }
});

// A double-decrement must not drive a gauge negative (Prometheus reads a
// negative gauge dip as a counter reset).
test("metricDec clamps gauges at zero", async () => {
  const { metricDec, renderMetrics } = await import("../src/metrics.js");
  metricDec("bridge_calls_active");
  metricDec("bridge_calls_active");
  assert.match(renderMetrics(), /bridge_calls_active 0\n/);
});

test("ReplayGuard clamps future-dated timestamps to now", () => {
  // isFresh accepts up to +window of clock skew; ts + window on top of that
  // would keep the tuple replayable for up to 2x the window.
  const g = new ReplayGuard(60_000);
  const now = 1_000_000;
  assert.equal(g.claim("c", now + 59_000, "s", now), true);
  const later = now + 60_001; // just past now + window
  assert.equal(g.claim("other", later, "s2", later), true);
  assert.equal(g.size, 1, "future-dated record swept at now + window");
});

test("loadConfig warns when MAX_CALL_MINUTES exceeds the token lifetime", () => {
  const saved = { ...process.env };
  const warnings: string[] = [];
  const origWarn = console.log;
  console.log = (line: string) => warnings.push(String(line));
  try {
    process.env.WORKER_SHARED_SECRET = "s";
    process.env.CARTESIA_API_KEY = "k";
    process.env.CARTESIA_AGENT_ID = "a";
    process.env.MAX_CALL_MINUTES = "90";
    loadConfig();
    assert.ok(warnings.some((w) => w.includes("access-token lifetime")));
  } finally {
    console.log = origWarn;
    process.env = saved;
  }
});
