import { logger } from "./log.js";

/**
 * Bridge configuration, entirely from environment variables.
 * The worker-side contract (HMAC secret, wire protocol) must match the
 * StandIn media bridge; the Cartesia side needs an API key and the id of a
 * deployed Line agent - the agent itself (LLM, tools, conversation logic) is
 * your code on Cartesia's platform, so unlike the sibling bridges there is
 * no per-session model/prompt wiring to do here beyond optional overrides.
 */

const log = logger("config");

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /** Bind address. */
  host: string;
  /** Must equal the shared secret the StandIn media bridge signs with (HMAC upgrade check). */
  workerSharedSecret: string;
  /** Server-side Cartesia key; mints per-call access tokens and calls Sonic TTS. Never rides the agent socket. */
  cartesiaApiKey: string;
  /** The deployed Line agent that answers calls (wss://{host}/agents/stream/{agentId}). */
  agentId: string;
  /** Cartesia API host (REST + agent WebSocket). Restricted to *.cartesia.ai. */
  apiHost: string;
  /** Cartesia-Version header sent on every request. */
  cartesiaVersion: string;
  /** Override the agent's default TTS voice for the call (start config.voice_id). Null = the agent's own voice. */
  voiceId: string | null;
  /** Deterministic opening line (start agent.introduction - also the natural place for a spoken AI disclosure). Null = the agent opens per its own code. */
  introduction: string | null;
  /**
   * System-prompt override (start agent.system_prompt). Null = the deployed
   * agent's own prompt is used untouched. When set, per-call caller context
   * (name, tenant, direction) is appended; either way the context also rides
   * the start metadata for your agent code.
   */
  systemPrompt: string | null;
  /** Sonic model for the deterministic governor goodbye via standalone TTS (e.g. sonic-2). Null = no deterministic goodbye; the bridge emits a goodbye_request custom event instead. */
  ttsModel: string | null;
  /** Voice for the goodbye TTS. Null = falls back to voiceId; without either, the deterministic goodbye is unavailable. */
  ttsVoiceId: string | null;
  /** Language for the goodbye TTS. */
  ttsLanguage: string;
  /**
   * Bridge-side call governor: hard cap on call duration in minutes
   * (fractional allowed). 0 = disabled. Cartesia doesn't know about your
   * billing; on limit the bridge speaks a goodbye and ends the call.
   */
  maxCallMinutes: number;
  /** Goodbye line the governor speaks (deterministic via TTS when CARTESIA_TTS_MODEL + a voice are set). */
  goodbyeText: string;
  /** How long to let the goodbye play out before session.end when its duration is unknown (goodbye_request fallback). */
  goodbyeGraceMs: number;
  /** Allowed clock skew for the HMAC timestamp, in ms (worker side documents +-60s). */
  hmacFreshnessMs: number;
  /** Max concurrent worker connections (0 = default 64). */
  maxConnections: number;
  /** Max concurrent connections from one remote IP (0 = default: same as maxConnections, i.e. no per-IP throttle). */
  maxConnectionsPerIp: number;
  /** Drop a worker that authenticates but never sends session.start after this many ms (0 = default 10s). */
  preStartTimeoutMs: number;
  /** Dead-peer window: end the call after this many ms without ANY worker message (0 = default 90s; the worker heartbeats every 30s). */
  workerIdleTimeoutMs: number;
  /** Trust X-Forwarded-For for the per-IP cap (only behind a proxy you control). */
  trustProxy: boolean;
  /** PEM cert/key paths for native TLS (wss). When both are set the bridge serves HTTPS itself; otherwise it is plain WS and MUST be fronted by a TLS terminator. */
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
}

/**
 * CARTESIA_API_KEY authenticates against this host (token mint + TTS), so an
 * attacker-influenced or fat-fingered host would exfiltrate the key. Restrict
 * it to Cartesia's own domain. Set CARTESIA_HOST_ALLOW_ANY=true only for a
 * deliberate proxy/test host.
 */
function validateCartesiaHost(name: string, host: string): string {
  if (process.env.CARTESIA_HOST_ALLOW_ANY === "true") {
    return host;
  }
  const h = host.toLowerCase();
  if (h === "cartesia.ai" || h.endsWith(".cartesia.ai")) {
    return host;
  }
  throw new Error(
    `${name} "${host}" is not a cartesia.ai host; the API key must not be sent elsewhere. ` +
      `Set CARTESIA_HOST_ALLOW_ANY=true to override for a trusted proxy.`,
  );
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * Parse a numeric env var, failing LOUD on a non-numeric value. `Number("abc")`
 * is NaN, which silently disables the governor (MAX_CALL_MINUTES) or throws an
 * opaque listen error (PORT). A typo should stop startup with a clear message.
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name}="${raw}" is not a number`);
  }
  // Fail loud on negatives too: e.g. MAX_CALL_MINUTES=-1 would pass Number.isFinite
  // and then `maxCallMinutes > 0` silently disables the governor - the same
  // silent-misconfig class numFromEnv exists to prevent. All these knobs are
  // counts/durations/minutes where a negative is never meaningful.
  if (n < 0) {
    throw new Error(`Env var ${name}="${raw}" must not be negative`);
  }
  return n;
}

export function loadConfig(): BridgeConfig {
  const cfg: BridgeConfig = {
    port: numFromEnv("PORT", 8080),
    host: process.env.BIND?.trim() || "0.0.0.0",
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    cartesiaApiKey: required("CARTESIA_API_KEY"),
    agentId: required("CARTESIA_AGENT_ID"),
    apiHost: validateCartesiaHost("CARTESIA_API_HOST", process.env.CARTESIA_API_HOST?.trim() || "api.cartesia.ai"),
    cartesiaVersion: process.env.CARTESIA_VERSION?.trim() || "2025-04-16",
    voiceId: optional("CARTESIA_VOICE_ID"),
    introduction: optional("CARTESIA_INTRODUCTION"),
    systemPrompt: optional("CARTESIA_SYSTEM_PROMPT"),
    ttsModel: optional("CARTESIA_TTS_MODEL"),
    ttsVoiceId: optional("CARTESIA_TTS_VOICE_ID"),
    ttsLanguage: process.env.CARTESIA_TTS_LANGUAGE?.trim() || "en",
    maxCallMinutes: numFromEnv("MAX_CALL_MINUTES", 0),
    goodbyeText:
      process.env.GOODBYE_TEXT ??
      "I'm sorry, we've reached the time limit for this call. Thank you for calling, goodbye!",
    goodbyeGraceMs: numFromEnv("GOODBYE_GRACE_MS", 8000),
    hmacFreshnessMs: numFromEnv("HMAC_FRESHNESS_MS", 60_000),
    maxConnections: numFromEnv("MAX_CONNECTIONS", 0),
    maxConnectionsPerIp: numFromEnv("MAX_CONNECTIONS_PER_IP", 0),
    preStartTimeoutMs: numFromEnv("PRE_START_TIMEOUT_MS", 0),
    workerIdleTimeoutMs: numFromEnv("WORKER_IDLE_TIMEOUT_MS", 0),
    trustProxy: process.env.TRUST_PROXY_XFF === "true",
    tlsCertPath: optional("TLS_CERT_PATH"),
    tlsKeyPath: optional("TLS_KEY_PATH"),
  };
  // The Line wire has no injection message, so without a TTS config the
  // governor goodbye is best-effort (a goodbye_request custom event the agent
  // code may or may not handle). Not an error - but the operator should know
  // the caller might hear silence before a governor cutoff.
  if (cfg.maxCallMinutes > 0 && !(cfg.ttsModel && (cfg.ttsVoiceId ?? cfg.voiceId))) {
    log.warn(
      "MAX_CALL_MINUTES is set without CARTESIA_TTS_MODEL + a voice id: the governor goodbye will be a " +
        "goodbye_request custom event only (silent unless your Line agent handles it). " +
        "Set CARTESIA_TTS_MODEL and CARTESIA_TTS_VOICE_ID for a spoken, deterministic goodbye.",
    );
  }
  return cfg;
}
