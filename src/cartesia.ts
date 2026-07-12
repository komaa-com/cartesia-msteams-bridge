import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Cartesia Line agent WebSocket client + the two REST calls the bridge needs
 * (a short-lived access token per call, and standalone Sonic TTS for the
 * deterministic governor goodbye).
 *
 * Wire reference (validated 2026-07-12 against the Line WebSocket API docs):
 * the client connects to wss://{host}/agents/stream/{agentId} with
 * `Authorization: Bearer <access token>` and a `Cartesia-Version` header,
 * then sends a `start` event ({config: {input_format}, agent overrides,
 * metadata}). The server acks with `ack` (echoing the config); media flows as
 * `media_input` / `media_output` events with base64 payloads - agent audio
 * comes back IN THE SAME FORMAT as config.input_format, so pinning
 * `pcm_16000` (the StandIn wire rate) makes the hot path copy-only in the
 * strongest sense: the base64 payload string is relayed verbatim, no decode,
 * no re-encode, no transcoding. `clear` tells the client to flush its
 * playback buffer (the caller barged in); `dtmf` carries keypad digits;
 * `custom` carries arbitrary metadata to the agent code; `transfer_call`
 * requests a phone transfer (not applicable on a Teams call). The server
 * closes idle connections after ~180 s - the socket sends protocol-level
 * pings to stay alive through silence.
 *
 * The Line agent itself (LLM, tools, conversation logic) is YOUR CODE
 * deployed on Cartesia's platform - this bridge is deliberately a transport,
 * not a tool host: there is no client-side tool channel on this wire.
 */

/** The one wire rate: StandIn PCM 16 kHz mono = Line `pcm_16000`. */
export const WIRE_SAMPLE_RATE = 16_000;

/** Line audio format matching the StandIn wire (agent audio returns in the same format). */
export const INPUT_FORMAT = "pcm_16000";

/** Protocol-level ping cadence: the server drops idle connections after ~180 s. */
const KEEPALIVE_INTERVAL_MS = 60_000;

/** Time bound on the REST calls (access token, TTS) and the WS handshake, so a
 *  hung endpoint can never wedge a call open. */
const CARTESIA_REST_TIMEOUT_MS = 10_000;

/** Access tokens are minted per call with the maximum lifetime (1 hour). */
const ACCESS_TOKEN_TTL_S = 3600;

// ---- server -> client event shapes (subset the bridge consumes) ----

export interface LineAck {
  event: "ack";
  stream_id?: string;
  config?: Record<string, unknown>;
}

export interface LineMediaOutput {
  event: "media_output";
  stream_id?: string;
  media?: { payload?: string };
}

export interface LineClear {
  event: "clear";
  stream_id?: string;
}

export interface LineTransferCall {
  event: "transfer_call";
  stream_id?: string;
  transfer?: { target_phone_number?: string };
}

/** Errors ride the generic Cartesia WS error object (keyed `type`, not `event`). */
export interface LineError {
  type: "error";
  status_code?: number;
  error_code?: string | null;
  title?: string;
  message?: string;
}

export type LineInbound =
  | LineAck
  | LineMediaOutput
  | LineClear
  | LineTransferCall
  | LineError
  | { event?: string; type?: string; [k: string]: unknown };

// ---- start builder ----

export interface CallerContext {
  callerName: string;
  tenantId: string;
  direction: string;
}

export interface StartOptions {
  streamId: string;
  /** Override the agent's default TTS voice. Null = the agent's own voice. */
  voiceId: string | null;
  /** Deterministic opening line (also the natural place for a spoken AI disclosure). Null = the agent opens per its own code. */
  introduction: string | null;
  /**
   * System-prompt override. Null = the deployed agent's own prompt is used
   * UNTOUCHED (caller context then rides metadata only) - the bridge must
   * never silently replace a prompt the operator wrote in their Line agent.
   */
  systemPrompt: string | null;
  caller: CallerContext;
  callId: string;
}

/**
 * The `start` event sent once, first message on the socket. Audio is pinned to
 * pcm_16000 (the StandIn wire rate; agent audio returns in the same format -
 * copy-only relay). Caller context ALWAYS rides `metadata` (the Line agent
 * code receives it); it is additionally appended to the system prompt only
 * when the operator overrides the prompt via CARTESIA_SYSTEM_PROMPT.
 */
export function buildStart(opts: StartOptions): Record<string, unknown> {
  const config: Record<string, unknown> = { input_format: INPUT_FORMAT };
  if (opts.voiceId) {
    config.voice_id = opts.voiceId;
  }
  const agent: Record<string, unknown> = {};
  if (opts.introduction) {
    agent.introduction = opts.introduction;
  }
  if (opts.systemPrompt) {
    agent.system_prompt =
      `${opts.systemPrompt.trim()}\n\n` +
      `Call context: you are speaking with ${opts.caller.callerName} ` +
      `(tenant: ${opts.caller.tenantId}) on an ${opts.caller.direction} Microsoft Teams call.`;
  }
  const start: Record<string, unknown> = {
    event: "start",
    stream_id: opts.streamId,
    config,
    metadata: {
      from: "msteams",
      callId: opts.callId,
      callerName: opts.caller.callerName,
      tenantId: opts.caller.tenantId,
      direction: opts.caller.direction,
    },
  };
  if (Object.keys(agent).length > 0) {
    start.agent = agent;
  }
  return start;
}

// ---- REST helpers ----

/**
 * Mint a short-lived, agent-scoped access token for one call. The WS is
 * authenticated with this token rather than the long-lived API key, so the
 * key itself never rides the per-call agent socket.
 */
export async function mintAccessToken(cfg: BridgeConfig): Promise<string> {
  const res = await fetch(`https://${cfg.apiHost}/access-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.cartesiaApiKey}`,
      "cartesia-version": cfg.cartesiaVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({ grants: { agent: true }, expires_in: ACCESS_TOKEN_TTL_S }),
    signal: AbortSignal.timeout(CARTESIA_REST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`access token failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) {
    throw new Error("access token response had no token");
  }
  return body.token;
}

/**
 * Standalone Sonic TTS for the deterministic governor goodbye: synthesize the
 * exact text as raw pcm_s16le @ 16 kHz and return the bytes. Only used when
 * CARTESIA_TTS_MODEL and a voice id are configured; without them the bridge
 * cannot speak deterministically (the Line wire has no injection message) -
 * it emits a `custom` {goodbye_request} event instead and relies on the grace.
 */
export async function synthesizeGoodbye(cfg: BridgeConfig, text: string): Promise<Buffer> {
  if (!cfg.ttsModel) {
    throw new Error("CARTESIA_TTS_MODEL not configured");
  }
  const voiceId = cfg.ttsVoiceId ?? cfg.voiceId;
  if (!voiceId) {
    throw new Error("no TTS voice: set CARTESIA_TTS_VOICE_ID (or CARTESIA_VOICE_ID)");
  }
  // Time-bound the synth: the governor's hard teardown deadline is armed before
  // this is awaited, but a fetch that hangs forever would still hold the promise
  // (and the mute latch) open.
  const res = await fetch(`https://${cfg.apiHost}/tts/bytes`, {
    method: "POST",
    headers: {
      "x-api-key": cfg.cartesiaApiKey,
      "cartesia-version": cfg.cartesiaVersion,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model_id: cfg.ttsModel,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      language: cfg.ttsLanguage,
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: WIRE_SAMPLE_RATE },
    }),
    signal: AbortSignal.timeout(CARTESIA_REST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`TTS failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- Line agent WebSocket session ----

export interface LineSessionHandlers {
  /** JSON events (`ack`, `clear`, `transfer_call`, errors, ...). */
  onMessage: (msg: LineInbound) => void;
  /** Agent audio: the base64 payload of a media_output event, pcm_16000 - relay verbatim. */
  onAudio: (base64Pcm: string) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
}

/** What the relay needs from an agent connection; CartesiaAgentSocket is the real one, tests fake it. */
export interface AgentPort {
  readonly isOpen: boolean;
  /** The one-time `start` event (audio format, agent overrides, metadata). Must be the first message. */
  sendStart(start: Record<string, unknown>): void;
  /** Caller audio: base64 PCM 16 kHz from the wire, re-wrapped as media_input - the payload is NOT decoded. */
  sendAudioChunk(base64Pcm: string): void;
  /** Keypad digit (the Line wire carries DTMF natively). */
  sendDtmf(digit: string): void;
  /** Arbitrary metadata to the agent code (live context notes, goodbye requests). */
  sendCustom(metadata: Record<string, unknown>): void;
  close(): void;
}

/** Injectable connector so tests can substitute a fake agent. */
export type LineConnector = (cfg: BridgeConfig, log: Logger, handlers: LineSessionHandlers) => Promise<AgentPort>;

/** One Line agent socket. Thin: framing + send helpers only; relay logic lives in session.ts. */
export class CartesiaAgentSocket implements AgentPort {
  private ws: WebSocket;
  private readonly log: Logger;
  private keepAlive: NodeJS.Timeout | null = null;
  private streamId: string | null = null;

  private constructor(ws: WebSocket, log: Logger) {
    this.ws = ws;
    this.log = log;
  }

  /**
   * Mint a per-call access token, open the agent WS, and wire handlers.
   * Resolves once the socket is OPEN (the `start` event may be sent from then
   * on; the session gates audio on the server's `ack`). One retry on a
   * transient connect failure.
   */
  static async connect(cfg: BridgeConfig, log: Logger, handlers: LineSessionHandlers): Promise<CartesiaAgentSocket> {
    let ws: WebSocket;
    try {
      ws = await CartesiaAgentSocket.openOnce(cfg);
    } catch (err) {
      log.warn(`Cartesia connect failed (${(err as Error).message}); retrying once`);
      await new Promise((r) => setTimeout(r, 250));
      ws = await CartesiaAgentSocket.openOnce(cfg);
    }
    const sock = new CartesiaAgentSocket(ws, log);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // The Line wire is JSON-only (audio rides base64 inside media events).
        log.warn("Cartesia sent an unexpected binary frame; dropping");
        return;
      }
      let msg: LineInbound | null = null;
      try {
        msg = JSON.parse(data.toString("utf8")) as LineInbound;
      } catch {
        log.warn("Cartesia sent an unparseable text frame; dropping");
        return;
      }
      try {
        // Hot path first: hand media_output payloads straight to onAudio.
        if ((msg as LineMediaOutput).event === "media_output") {
          const payload = (msg as LineMediaOutput).media?.payload;
          if (typeof payload === "string" && payload) {
            handlers.onAudio(payload);
          }
          return;
        }
        handlers.onMessage(msg);
      } catch (err) {
        // Never let a handler throw escape the ws listener - that is an
        // uncaught exception and takes the whole process (all calls) down.
        log.error(`error handling Cartesia ${(msg as { event?: string }).event ?? "event"}: ${(err as Error).message}`);
      }
    });
    ws.on("close", (code, reason) => {
      sock.stopKeepAlive();
      handlers.onClose(code, reason.toString("utf8"));
    });
    ws.on("error", (err) => handlers.onError(err as Error));

    // The server closes idle connections after ~180 s; protocol-level pings
    // keep the socket alive through hold music / long silences.
    sock.keepAlive = setInterval(() => {
      if (sock.isOpen) {
        try {
          sock.ws.ping();
        } catch {
          /* socket mid-close */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
    sock.keepAlive.unref?.();
    return sock;
  }

  /** Mint a token and open the socket once; rejects on any failure. */
  private static async openOnce(cfg: BridgeConfig): Promise<WebSocket> {
    // Per-call token: the long-lived API key authenticates only the HTTPS
    // token mint, never the agent socket itself.
    const token = await mintAccessToken(cfg);
    const url = `wss://${cfg.apiHost}/agents/stream/${encodeURIComponent(cfg.agentId)}`;
    // Bound the WS open: without handshakeTimeout, a blackholed TCP connect or
    // a stalled TLS/upgrade handshake would hang onSessionStart forever (the
    // governor is only armed after connect).
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}`, "cartesia-version": cfg.cartesiaVersion },
      handshakeTimeout: CARTESIA_REST_TIMEOUT_MS,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = (): void => {
          ws.off("error", onError);
          ws.off("close", onCloseEarly);
          resolve();
        };
        const onError = (err: Error): void => {
          ws.off("open", onOpen);
          ws.off("close", onCloseEarly);
          reject(err);
        };
        const onCloseEarly = (code: number): void => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          reject(new Error(`socket closed before open (${code})`));
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onCloseEarly);
      });
    } catch (err) {
      // The rejected socket is now orphaned. Without a permanent 'error'
      // listener a later error event (TCP reset on the half-open socket) is an
      // uncaught EventEmitter 'error' -> the whole process (all live calls)
      // crashes. Neutralize it before discarding.
      ws.on("error", () => {});
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
      throw err;
    }
    return ws;
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.isOpen) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendStart(start: Record<string, unknown>): void {
    this.streamId = typeof start.stream_id === "string" ? start.stream_id : randomUUID();
    this.send(start);
  }

  /** Caller audio -> agent: the base64 wire payload rides media_input VERBATIM (no decode, no re-encode). */
  sendAudioChunk(base64Pcm: string): void {
    this.send({ event: "media_input", stream_id: this.streamId, media: { payload: base64Pcm } });
  }

  sendDtmf(digit: string): void {
    this.send({ event: "dtmf", stream_id: this.streamId, dtmf: digit });
  }

  sendCustom(metadata: Record<string, unknown>): void {
    this.send({ event: "custom", stream_id: this.streamId, metadata });
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }

  close(): void {
    this.stopKeepAlive();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(1000, "session-end");
    }
  }
}
