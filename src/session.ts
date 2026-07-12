import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { BridgeConfig } from "./config.js";
import { logger, type Logger } from "./log.js";
import {
  parseWorkerMessage,
  pcm16kBytesToMs,
  type AudioFrameMessage,
  type SessionStartMessage,
  type WorkerOutbound,
} from "./protocol.js";
import {
  buildStart,
  synthesizeGoodbye,
  CartesiaAgentSocket,
  type AgentPort,
  type CallerContext,
  type LineConnector,
  type LineError,
  type LineInbound,
  type LineTransferCall,
} from "./cartesia.js";
import { metricInc, metricObserve } from "./metrics.js";

/** Pending caller-audio cap while Cartesia connects + acks: 250 x 20 ms = 5 s. */
const MAX_PENDING_AUDIO_FRAMES = 250;

/** 20 ms of PCM 16 kHz mono 16-bit = 16000 * 0.02 * 2 = 640 bytes (one hot-path frame). */
const PCM16K_FRAME_BYTES = 640;

/** Outbound (bridge->worker) send-buffer cap. Above this, drop realtime frames
 *  instead of letting a stalled worker balloon memory. Matches the siblings. */
const MAX_OUTBOUND_BUFFER_BYTES = 1 * 1024 * 1024;

/** Extra headroom on top of the goodbye grace before the governor force-ends the
 *  call, so a hung TTS synth can never wedge a time-limited call open. */
const GOODBYE_HARD_CAP_MS = 8_000;

/** Bound the ack wait: a start the server never acks must not leave the call
 *  open and silent until the dead-peer timer. */
const ACK_TIMEOUT_MS = 10_000;

/** Min gap between "now speaking" context events (group calls), so VAD
 *  flapping between speakers cannot spam the agent. */
const SPEAKER_UPDATE_MIN_INTERVAL_MS = 5_000;

/** Dead-peer window: worker heartbeats every 30 s -> 3 missed pings ends the call. */
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 90_000;

/**
 * One Teams call: pairs the worker WebSocket with one Cartesia Line agent
 * stream and relays between them.
 *
 * Audio is relayed VERBATIM in both directions - the wire is base64 PCM
 * 16 kHz and the Line stream is pinned to pcm_16000 (agent audio returns in
 * the same format), so the hot path passes the base64 payload string through
 * UNTOUCHED: no decode, no re-encode, no transcoding.
 *
 * The Line agent's brain (LLM, tools, hangup logic) is your code on
 * Cartesia's platform - this session is a transport. Live context
 * (participants, active speaker, recording state) is forwarded as `custom`
 * events for your agent code to consume; DTMF rides the wire natively.
 */
export class CallSession {
  private readonly cfg: BridgeConfig;
  private readonly worker: WebSocket;
  private readonly log: Logger;
  private readonly connectLine: LineConnector;

  private line: AgentPort | null = null;
  private callId: string;
  private closed = false;
  /** Call start, for the duration metrics at teardown. */
  private readonly startMs = Date.now();

  // outbound audio bookkeeping (bridge -> worker)
  private outSeq = 0;
  private outTimestampMs = 0;
  // backpressure-warn throttle (avoid ~50 warn lines/s when a worker stalls)
  private droppedFrames = 0;
  private lastBackpressureWarnMs = 0;

  // Hard mute: set ONLY while a deterministic TTS goodbye plays, so late agent
  // frames cannot talk over the sign-off. There is NO barge-in ghost filter
  // here on purpose: Line's `clear` is delivered in-band on the same ordered
  // socket, so any media_output that arrives after it is genuinely new speech,
  // not a stale in-flight frame (unlike the Deepgram sibling, where the
  // barge-in signal races pipelined TTS frames).
  private muteAgentAudio = false;
  // first goodbye wins: both governors (worker assistant.say + bridge time limit) can race
  private goodbyeInProgress = false;
  // group-call speaker attribution: last name surfaced + a rate limit so VAD flapping can't spam
  private lastSpeakerName: string | null = null;
  private lastSpeakerUpdateMs = 0;
  private participantCount = 1;
  // Caller audio buffered until the session is READY: from session.start
  // through connect AND the server's `ack` (media_input needs the acked
  // stream; the ack also confirms the pcm_16000 config took).
  private pendingAudio: string[] = [];
  private sessionStarted = false;
  private acked = false;
  // bound the ack wait: a start the server never acks must not hang the call
  private ackTimer: NodeJS.Timeout | null = null;
  // per-call caller context (rides start metadata; appended to a prompt override)
  private callerCtx: CallerContext | null = null;

  // Teams recording state, forwarded to the agent code as a custom event
  private recordingActive = false;
  private recordingStatus = "unknown";
  // first agent frame: sanity-log the byte length (output-format tripwire)
  private firstAgentFrameSeen = false;

  // bridge-side call governor
  private governorTimer: NodeJS.Timeout | null = null;
  // hard-bounded teardown timer for the goodbye grace (so a hung TTS can't wedge the call open)
  private goodbyeTimer: NodeJS.Timeout | null = null;
  // invoked exactly once when the session tears down (server uses it to de-register)
  private readonly onClosed: (() => void) | undefined;

  // Dead-peer detection: the worker heartbeats every 30 s, but a half-open TCP
  // socket (NAT timeout, node crash, network drop without FIN) delivers nothing
  // and never fires 'close' - the session would stay "live" for hours, holding
  // the billed Line stream open AND 409-blocking every reconnect for this
  // callId. Track the last inbound worker message and tear down after the idle
  // window (default 90 s = 3 missed heartbeats).
  private lastWorkerActivityMs = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    cfg: BridgeConfig,
    worker: WebSocket,
    callId: string,
    connectLine: LineConnector = CartesiaAgentSocket.connect,
    onClosed?: () => void,
  ) {
    this.cfg = cfg;
    this.worker = worker;
    this.callId = callId;
    this.log = logger(`call:${callId.slice(0, 12)}`);
    this.connectLine = connectLine;
    this.onClosed = onClosed;

    worker.on("message", (data) => {
      this.lastWorkerActivityMs = Date.now(); // any inbound frame proves the peer is alive
      // parity with the Cartesia side: a handler throw must not escape the ws
      // listener (uncaught exception -> process down)
      try {
        this.onWorkerMessage(data as Buffer);
      } catch (err) {
        this.log.error(`error handling worker message: ${(err as Error).message}`);
      }
    });
    worker.on("close", () => this.teardown("worker-closed"));
    worker.on("error", (err) => {
      this.log.warn(`worker socket error: ${(err as Error).message}`);
      this.teardown("worker-error");
    });

    const idleMs = cfg.workerIdleTimeoutMs > 0 ? cfg.workerIdleTimeoutMs : DEFAULT_WORKER_IDLE_TIMEOUT_MS;
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastWorkerActivityMs > idleMs) {
        this.log.warn(`no worker message in ${idleMs}ms (dead peer?); ending the call`);
        this.endCall("worker-idle-timeout");
      }
    }, Math.max(20, Math.min(idleMs / 3, 30_000)));
    this.idleTimer.unref?.();
  }

  /** Whether session.start has arrived (the server's pre-start timer asks). */
  get hasStarted(): boolean {
    return this.sessionStarted;
  }

  // ---- worker -> bridge ----

  private onWorkerMessage(data: Buffer): void {
    const msg = parseWorkerMessage(data);
    if (!msg) {
      this.log.warn("unparseable worker frame; dropping");
      return;
    }
    switch (msg.type) {
      case "session.start":
        this.onSessionStart(msg).catch((err) => {
          // End the call NOW: without this the call would sit half-alive (no
          // agent socket, no governor) until a watchdog notices minutes later.
          this.log.error(`session.start handling failed: ${(err as Error).message}`);
          this.endCall("session-start-failed");
        });
        break;
      case "audio.frame":
        // hot path: caller audio -> agent, verbatim (the base64 payload rides
        // media_input untouched). Until the server acks the start event,
        // buffer (bounded) instead of sending - the ack confirms the stream
        // and the pcm_16000 config, and this window also covers the connect.
        if (typeof msg.payloadBase64 !== "string" || !msg.payloadBase64) {
          break; // junk on the wire must not become media:{payload:undefined}
        }
        if (this.line && this.acked) {
          this.line.sendAudioChunk(msg.payloadBase64);
          metricInc("bridge_frames_to_agent_total");
          this.noteSpeaker(msg.speakerName);
        } else if (this.sessionStarted) {
          this.pendingAudio.push(msg.payloadBase64);
          if (this.pendingAudio.length > MAX_PENDING_AUDIO_FRAMES) {
            this.pendingAudio.shift(); // keep the most recent speech
          }
        }
        break;
      case "ping":
        this.sendToWorker({ type: "pong", ts: msg.ts });
        break;
      case "participants":
        if (typeof msg.count !== "number") {
          break;
        }
        this.participantCount = msg.count;
        this.pushContext({
          note:
            msg.count <= 1
              ? "This is a 1:1 call with a single human caller."
              : `There are ${msg.count} human participants on this call. Stay quiet unless directly addressed.`,
          participantCount: msg.count,
        });
        break;
      case "dtmf":
        // Native on the Line wire - no prompt-note workaround needed.
        if (this.line && this.acked && typeof msg.digit === "string" && msg.digit) {
          this.line.sendDtmf(msg.digit);
        }
        break;
      case "recording.status":
        this.recordingActive = msg.status === "active";
        this.recordingStatus = msg.status;
        this.log.info(`recording.status = ${msg.status}`);
        this.pushContext({ note: `Teams recording is now ${msg.status}.`, recordingStatus: msg.status });
        break;
      case "video.frame":
        // The Line wire is audio-only and has no tool channel back to the
        // bridge, so there is no vision path - frames are dropped, not buffered.
        this.log.debug("ignoring video.frame (no vision path on the Line wire)");
        break;
      case "assistant.say":
        // worker-side governor: speak, the worker tears down afterwards
        this.performGoodbye(msg.text).catch((err) =>
          this.log.error(`goodbye failed: ${(err as Error).message}`),
        );
        break;
      case "session.end":
        this.log.info(`session.end from worker: ${msg.reason}`);
        this.teardown("worker-session-end");
        break;
      default:
        this.log.debug(`ignoring worker message type ${(msg as { type: string }).type}`);
    }
  }

  private async onSessionStart(msg: SessionStartMessage): Promise<void> {
    if (this.sessionStarted) {
      // A second session.start would orphan the first Line stream; the worker
      // sends exactly one per connection, so treat a repeat as a protocol error.
      this.log.warn("duplicate session.start ignored");
      return;
    }
    this.sessionStarted = true;
    if (msg.callId && msg.callId !== this.callId) {
      // must match the HMAC-authenticated callId in the URL path (wire contract).
      // Use endCall so the worker gets a session.end (clean reason) rather than a
      // bare socket close it would log as an unexpected drop.
      this.log.error(`session.start callId ${msg.callId} != URL callId ${this.callId}; closing`);
      this.endCall("callid-mismatch");
      return;
    }
    this.log.info(`session.start (direction=${msg.direction ?? "inbound"}, recording=${msg.recordingStatus ?? "unknown"})`);
    this.recordingActive = msg.recordingStatus === "active";
    this.recordingStatus = msg.recordingStatus ?? "unknown";
    // Per-call personalization: caller context rides the start metadata (and
    // the prompt override, when configured). CallerInfo fields are all
    // nullable - default, never send null.
    this.callerCtx = {
      callerName: msg.caller?.displayName?.trim() || "caller",
      tenantId: msg.caller?.tenantId?.trim() || "unknown-tenant",
      direction: msg.direction?.trim() || "inbound",
    };

    let line: AgentPort;
    try {
      line = await this.connectLine(this.cfg, this.log, {
        onMessage: (m) => this.onLineMessage(m),
        onAudio: (b64) => this.onLineAudio(b64),
        onClose: (code, reason) => {
          this.log.info(`Cartesia socket closed (${code} ${reason})`);
          this.endCall("agent-disconnected");
        },
        onError: (err) => this.log.warn(`Cartesia socket error: ${err.message}`),
      });
    } catch (err) {
      metricInc("bridge_agent_connect_failures_total");
      this.log.error(`could not open Cartesia Line stream: ${(err as Error).message}`);
      this.endCall("agent-unavailable");
      return;
    }

    // The worker may have dropped (ring cancelled, rollout) DURING the connect
    // above. If so, teardown already ran with this.line still null - assigning
    // the just-opened socket now would orphan a live, billed Line stream that
    // nothing ever closes. Close it and bail.
    if (this.closed) {
      this.log.info("worker closed during Cartesia connect; closing the orphaned agent socket");
      try {
        line.close();
      } catch {
        /* already closing */
      }
      return;
    }
    this.line = line;

    // The one-time start event: audio pinned to pcm_16000, agent overrides
    // (voice/introduction/prompt) only when configured, caller context in the
    // metadata either way.
    this.line.sendStart(
      buildStart({
        streamId: randomUUID(),
        voiceId: this.cfg.voiceId,
        introduction: this.cfg.introduction,
        systemPrompt: this.cfg.systemPrompt,
        caller: this.callerCtx,
        callId: this.callId,
      }),
    );
    // Audio must wait for the server's ack (see onLineMessage); bound that
    // wait so an un-acked start cannot leave the call open and silent until
    // the dead-peer timer.
    this.ackTimer = setTimeout(() => {
      if (!this.acked && !this.closed) {
        this.log.error("no ack from Cartesia within 10s; ending the call");
        this.endCall("agent-unavailable");
      }
    }, ACK_TIMEOUT_MS);
    this.ackTimer.unref?.();
    this.log.info("Cartesia Line stream open; waiting for ack");

    // Bridge-side governor: Cartesia doesn't know about your billing.
    if (this.cfg.maxCallMinutes > 0) {
      const limitMs = this.cfg.maxCallMinutes * 60_000;
      this.governorTimer = setTimeout(() => {
        this.onGovernorLimit().catch((err) => this.log.error(`governor error: ${(err as Error).message}`));
      }, limitMs);
      this.log.info(`governor armed: max ${this.cfg.maxCallMinutes} min`);
    }
  }

  /** Time limit hit: speak the goodbye, let it play out, then tear the call down. */
  private async onGovernorLimit(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.log.info("governor: call time limit reached");
    // If the worker-side governor already started a goodbye, its hard-bounded
    // backstop is armed - do NOT overwrite that timer (the call ends either
    // way, and clobbering it could cut off a goodbye that is still playing).
    if (this.goodbyeInProgress) {
      this.log.info("a goodbye is already in progress; keeping its deadline");
      return;
    }
    // Guarantee teardown regardless of the goodbye. Arm a HARD-bounded
    // deadline BEFORE awaiting performGoodbye - a hung/slow TTS must never
    // wedge the call open past its limit.
    const hardMs = this.cfg.goodbyeGraceMs + GOODBYE_HARD_CAP_MS;
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), hardMs);
    this.goodbyeTimer.unref?.();
    // performGoodbye's TTS fetch is itself time-bounded (see synthesizeGoodbye).
    const playedMs = await this.performGoodbye(this.cfg.goodbyeText);
    if (this.closed) {
      return; // the hard deadline (or another path) already tore down
    }
    // Deterministic TTS reports its real duration; the custom-event fallback
    // does not. Reschedule to the real grace, but never later than the hard cap.
    const graceMs = Math.min(playedMs ?? this.cfg.goodbyeGraceMs, hardMs);
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
    }
    // Flush-aware: playedMs measures AUDIO duration, but the frames sit in the
    // worker socket's send buffer - under backpressure the close could race
    // the still-draining goodbye. Bounded, so the deadline stays hard.
    this.goodbyeTimer = setTimeout(() => this.endCallAfterFlush("time-limit"), graceMs + 500);
    this.goodbyeTimer.unref?.();
  }

  /**
   * Group-call speaker attribution: the worker tags audio.frame with the active
   * speaker's display name. Forward it to the agent code as a custom event.
   * Only in group calls (1:1 attribution is noise), only when the name CHANGES,
   * and rate-limited so VAD flapping between speakers cannot spam the agent.
   */
  private noteSpeaker(name: string | null | undefined): void {
    if (!name || this.participantCount <= 1) {
      return;
    }
    const now = Date.now();
    if (name === this.lastSpeakerName || now - this.lastSpeakerUpdateMs < SPEAKER_UPDATE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastSpeakerName = name;
    this.lastSpeakerUpdateMs = now;
    this.pushContext({ note: `The person now speaking is ${name}.`, activeSpeaker: name });
  }

  /**
   * Forward live call context (participants, active speaker, recording state)
   * to the agent code as a `custom` event ({type: "call_context", note, ...}).
   * The Line wire has no prompt-update message - your agent code decides what
   * to do with these (see the README for the event shapes). Context that lands
   * before the ack is dropped, not queued: the start metadata carries the
   * initial state, and these events are advisory.
   */
  private pushContext(fields: Record<string, unknown>): void {
    if (this.closed || !this.line || !this.acked) {
      return;
    }
    this.line.sendCustom({ type: "call_context", ...fields });
  }

  // ---- Cartesia -> bridge ----

  /** Agent audio (base64 pcm_16000 from media_output): mute filter, then relay verbatim. */
  private onLineAudio(base64Pcm: string): void {
    if (!this.firstAgentFrameSeen) {
      // Output-format tripwire: the Line docs imply (but do not state) that
      // media_output mirrors config.input_format. An odd byte length cannot be
      // 16-bit PCM at all; the length log makes a rate mismatch diagnosable on
      // the first live call instead of shipping silent garbage to Teams.
      this.firstAgentFrameSeen = true;
      const bytes = Buffer.byteLength(base64Pcm, "base64");
      this.log.info(`first agent audio frame: ${bytes} bytes (${pcm16kBytesToMs(bytes)}ms if pcm_16000)`);
      if (bytes % 2 !== 0) {
        this.log.warn("first agent frame has an ODD byte length - this is not 16-bit PCM; check the agent's output format");
      }
    }
    if (this.muteAgentAudio) {
      this.log.debug("dropping agent audio (deterministic goodbye playing)");
      return;
    }
    this.emitAudioToWorker(base64Pcm);
  }

  private onLineMessage(msg: LineInbound): void {
    // Errors ride the generic Cartesia error object, keyed `type` not `event`.
    if ((msg as LineError).type === "error") {
      const err = msg as LineError;
      metricInc("bridge_agent_errors_total");
      this.log.warn(
        `Cartesia error event: ${err.error_code ?? err.status_code ?? "unknown"}: ${err.message ?? err.title ?? "no detail"}`,
      );
      return;
    }
    const event = (msg as { event?: string }).event;
    switch (event) {
      case "ack": {
        // The stream is confirmed (format + agent config took). Flush the
        // caller speech buffered since session.start, oldest first.
        this.acked = true;
        if (this.ackTimer) {
          clearTimeout(this.ackTimer);
          this.ackTimer = null;
        }
        if (this.line) {
          for (const chunk of this.pendingAudio) {
            this.line.sendAudioChunk(chunk);
            metricInc("bridge_frames_to_agent_total");
          }
        }
        this.pendingAudio = [];
        // Initial-context snapshot: participants/recording can land BEFORE the
        // ack (pushContext drops pre-ack events by design), and the initial
        // recording state arrives in session.start - without this the agent
        // code would never learn the state the call started in.
        this.line?.sendCustom({
          type: "call_context",
          note: "Call context snapshot at stream start.",
          participantCount: this.participantCount,
          recordingStatus: this.recordingStatus,
        });
        this.log.info("ack received; relaying");
        break;
      }
      case "clear": {
        // The agent wants queued playback flushed NOW - the caller barged in
        // (or the agent superseded its own utterance). Mirror the cut to the
        // Teams side. Frames after this are new speech (in-band ordering), so
        // no ghost-drop is needed.
        this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
        this.log.info("clear: flushing queued playback (barge-in)");
        break;
      }
      case "transfer_call": {
        // Phone-number transfer has no Teams-side equivalent on this wire.
        const target = (msg as LineTransferCall).transfer?.target_phone_number;
        this.log.warn(`transfer_call to ${target ?? "unknown"} is not supported on a Teams call; ignoring`);
        break;
      }
      default:
        this.log.debug(`ignoring Cartesia event ${event ?? "(untyped)"}`);
    }
  }

  // ---- governor goodbye ----

  /**
   * Speak a goodbye line (both governors: worker assistant.say and the
   * bridge-side time limit). Flushes queued playback first (assistant.cancel)
   * so stale agent audio cannot delay the goodbye.
   *
   * Preferred: deterministic, the exact text via standalone Sonic TTS
   * (CARTESIA_TTS_MODEL + a voice id) - the agent is hard-muted while it
   * plays and the real duration (ms) is returned. Fallback: the Line wire has
   * no injection message, so the bridge emits a `custom`
   * {type: "goodbye_request", text} event (your agent code MAY speak it) and
   * relies on the grace window; duration unknown (null).
   */
  private async performGoodbye(text: string): Promise<number | null> {
    // Both governors can race (worker assistant.say + bridge time limit). Running
    // performGoodbye twice would double-speak and leave the mute latch in an
    // ambiguous state - first one wins.
    if (this.goodbyeInProgress) {
      this.log.info("goodbye already in progress; ignoring duplicate");
      return null;
    }
    this.goodbyeInProgress = true;
    this.log.info("speaking goodbye");
    // Backstop teardown for the WORKER-side governor path (assistant.say): the
    // worker is expected to tear the call down after the goodbye, but if it is
    // buggy/slow the call must not sit open (agent muted) until the dead-peer
    // timer. The bridge-side governor arms its own tighter deadline first, in
    // which case this is skipped.
    if (!this.goodbyeTimer) {
      this.goodbyeTimer = setTimeout(() => this.endCall("goodbye-timeout"), this.cfg.goodbyeGraceMs + GOODBYE_HARD_CAP_MS);
      this.goodbyeTimer.unref?.();
    }
    this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
    if (this.cfg.ttsModel && (this.cfg.ttsVoiceId ?? this.cfg.voiceId)) {
      try {
        this.muteAgentAudio = true; // only the deterministic goodbye may speak now
        const pcm = await synthesizeGoodbye(this.cfg, text); // returns 16 kHz wire PCM
        // Emit as 20 ms frames like the hot path, rather than one multi-second
        // frame, so playback does not depend on the worker re-aligning a giant
        // chunk. The goodbye is the LAST thing the caller hears - a
        // load-bearing utterance, not disposable realtime audio. Never drop it
        // under worker backpressure (undroppable), unlike the normal hot path.
        for (let off = 0; off < pcm.length; off += PCM16K_FRAME_BYTES) {
          this.emitAudioToWorker(pcm.subarray(off, off + PCM16K_FRAME_BYTES).toString("base64"), true);
        }
        return pcm16kBytesToMs(pcm.length);
      } catch (err) {
        this.muteAgentAudio = false; // fallback: the agent must stay audible
        this.log.warn(`goodbye TTS failed (${(err as Error).message}); falling back to a goodbye_request event`);
      }
    }
    // No deterministic path: ask the agent code to speak it. This is advisory -
    // a Line agent that does not handle the event stays silent, and the
    // goodbye grace/backstop still ends the call either way. loadConfig()
    // warns at startup when the governor is armed without a TTS config.
    this.line?.sendCustom({ type: "goodbye_request", text });
    return null;
  }

  // ---- plumbing ----

  private emitAudioToWorker(base64Pcm: string, undroppable = false): void {
    const frame: AudioFrameMessage = {
      type: "audio.frame",
      seq: this.outSeq++,
      timestampMs: Math.round(this.outTimestampMs),
      payloadBase64: base64Pcm,
    };
    // Advance the timeline by the actual PCM duration. Buffer.byteLength
    // computes the decoded size from the string length + padding - it does NOT
    // decode, so the hot path stays copy-only.
    this.outTimestampMs += pcm16kBytesToMs(Buffer.byteLength(base64Pcm, "base64"));
    metricInc("bridge_frames_to_worker_total");
    this.sendToWorker(frame, undroppable);
  }

  private sendToWorker(msg: WorkerOutbound, undroppable = false): void {
    if (this.worker.readyState !== this.worker.OPEN) {
      return;
    }
    // Backpressure guard: ws.send is fire-and-forget, so if the worker stalls,
    // bufferedAmount grows unbounded (50 audio.frames/s) and leaks memory.
    // Above the cap, drop this frame rather than queue it - audio is realtime,
    // a stale frame is worthless, and this bounds memory (parity with siblings).
    // ONLY the continuous realtime type (audio.frame, ~50/s) is droppable.
    // Control frames (assistant.cancel, session.end, pong) are tiny and
    // semantically load-bearing. (Goodbye TTS frames are audio.frame on the
    // wire but semantically a control utterance - performGoodbye marks them
    // undroppable.)
    const droppable = msg.type === "audio.frame" && !undroppable;
    if (droppable && this.worker.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      // Throttle the log: at ~50 frames/s a stalled worker would emit 50 warn
      // lines/s. Count drops and warn at most once per second with the total.
      this.droppedFrames++;
      metricInc("bridge_frames_dropped_total");
      const now = Date.now();
      if (now - this.lastBackpressureWarnMs >= 1000) {
        this.log.warn(
          `worker send backpressure: dropped ${this.droppedFrames} frame(s) (buffered ${this.worker.bufferedAmount} bytes)`,
        );
        this.lastBackpressureWarnMs = now;
        this.droppedFrames = 0;
      }
      return;
    }
    this.worker.send(JSON.stringify(msg));
  }

  /**
   * Graceful external shutdown (e.g. SIGTERM drain): tell the worker the call
   * is ending, then close both sockets. A goodbye already in progress is left
   * to finish - its hard-bounded backstop tears the call down - so a redeploy
   * cannot cut off the last thing the caller hears (the server's drain waits
   * for it). Idempotent via teardown's closed flag.
   */
  shutdown(reason: string): void {
    if (this.goodbyeInProgress && !this.closed) {
      this.log.info(`${reason}: goodbye in progress; letting it play out (backstop armed)`);
      return;
    }
    this.endCall(reason);
  }

  /** Whether this session is still open (the server's drain polls this). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * endCall once the worker socket's send buffer has drained (bounded): used
   * by the soft goodbye deadline so queued goodbye frames are not cut off by
   * the close handshake. The hard backstops call endCall directly.
   */
  private endCallAfterFlush(reason: string, maxWaitMs = 2000): void {
    const deadline = Date.now() + maxWaitMs;
    const tick = (): void => {
      if (this.closed) {
        return;
      }
      if (this.worker.bufferedAmount === 0 || Date.now() > deadline) {
        this.endCall(reason);
        return;
      }
      setTimeout(tick, 50).unref?.();
    };
    tick();
  }

  /** Ask the worker to tear the call down, then close both sockets. */
  private endCall(reason: string): void {
    if (!this.closed) {
      this.sendToWorker({ type: "session.end", reason });
    }
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.log.info(`teardown: ${reason}`);
    // call duration: cumulative counter (averages) + histogram (p50/p95/p99)
    const durationS = (Date.now() - this.startMs) / 1000;
    metricInc("bridge_call_seconds_total", durationS);
    metricObserve("bridge_call_duration_seconds", durationS);
    // symmetry: the mute latch must never outlive the goodbye that set it
    this.muteAgentAudio = false;
    if (this.governorTimer) {
      clearTimeout(this.governorTimer);
      this.governorTimer = null;
    }
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);
      this.goodbyeTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    try {
      this.line?.close();
    } catch {
      /* already closing */
    }
    try {
      this.worker.close(1000, reason);
    } catch {
      /* already closing */
    }
    this.pendingAudio = [];
    // let the server de-register this call (registry eviction, dup-callId dedup)
    try {
      this.onClosed?.();
    } catch {
      /* registry callback must never throw back into teardown */
    }
  }
}
