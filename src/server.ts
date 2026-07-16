import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BridgeConfig } from "./config.js";
import { isFresh, verify, LEGACY_SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./hmac.js";
import { logger } from "./log.js";
import { CallSession } from "./session.js";
import type { LineConnector } from "./cartesia.js";
import { metricDec, metricInc, renderMetrics } from "./metrics.js";

const log = logger("server");

/**
 * Worker-facing WebSocket server. The StandIn media bridge dials
 * {wsBaseUrl}/{callId} with an HMAC-signed upgrade
 * (X-StandIn-Timestamp / -Signature over "{timestampMs}.{callId}");
 * the bridge validates exactly like the sibling bridges do.
 */

// DoS guards - parity with the sibling bridges. A single shared secret gates
// the upgrade, but a buggy or compromised worker (or a leaked secret) must not
// be able to exhaust memory/sockets.
/** Max inbound WS frame. Caller audio is ~640 B/frame; a JPEG video.frame is the
 *  large one. 2 MB matches the siblings and bounds a single message. */
const MAX_INBOUND_PAYLOAD_BYTES = 2 * 1024 * 1024;

/** WS-level ping interval; a client that misses a pong is terminated next tick. */
const WORKER_HEARTBEAT_MS = 30_000;
/** Max concurrent worker connections (one per live call). */
const DEFAULT_MAX_CONNECTIONS = 64;
/** A worker that authenticates but never sends session.start is dropped after this. */
const DEFAULT_PRE_START_TIMEOUT_MS = 10_000;
/** Bounded window for queued session.end frames + close handshakes to flush on shutdown. */
const SHUTDOWN_GRACE_MS = 2_000;

/** callId = last non-empty path segment of the upgrade URL. */
export function callIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  try {
    // A malformed percent-escape (e.g. `%zz`) makes decodeURIComponent throw
    // URIError. This runs inside the "upgrade" listener BEFORE auth, so an
    // unguarded throw would be an uncaught exception that kills the process and
    // drops every live call - a pre-auth remote crash. Treat it as no callId.
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Single-use guard for verified upgrade tuples (callId, ts, sig). Even inside
 * the freshness window, a captured handshake must not be replayable to open a
 * second (ghost) session for the same call. Records survive until the timestamp
 * itself stops being fresh (ts + window), matching the sibling bridges.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  /** Returns true if this tuple is NEW (and records it); false if already used. */
  claim(callId: string, ts: number, sig: string, nowMs = Date.now()): boolean {
    for (const [key, expiry] of this.seen) {
      if (expiry <= nowMs) {
        this.seen.delete(key);
      }
    }
    const key = `${callId}.${ts}.${sig}`;
    if (this.seen.has(key)) {
      return false;
    }
    // Expire when the timestamp stops being fresh, not "now + window": the tuple
    // is unusable past ts + windowMs anyway (isFresh would reject it). Clamp
    // future-dated timestamps to now - isFresh accepts up to +window of clock
    // skew, and ts + window on top of that would keep the tuple replayable for
    // up to 2x the window.
    this.seen.set(key, Math.min(ts, nowMs) + this.windowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export function authorizeUpgrade(
  cfg: BridgeConfig,
  req: IncomingMessage,
  replay?: ReplayGuard,
): { callId: string } | { error: string } {
  const callId = callIdFromUrl(req.url);
  if (!callId) {
    return { error: "no callId in path" };
  }
  // Fail closed: an empty/unset shared secret must reject every upgrade rather
  // than authenticating anyone. loadConfig() requires it, but never trust that.
  if (!cfg.workerSharedSecret) {
    return { error: "bridge shared secret is not configured" };
  }
  const tsHeader = req.headers[TIMESTAMP_HEADER] ?? req.headers[LEGACY_TIMESTAMP_HEADER];
  const sigHeader = req.headers[SIGNATURE_HEADER] ?? req.headers[LEGACY_SIGNATURE_HEADER];
  const ts = Number(Array.isArray(tsHeader) ? tsHeader[0] : tsHeader);
  const sig = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? "";
  if (!isFresh(ts, cfg.hmacFreshnessMs)) {
    return { error: "stale or missing timestamp" };
  }
  if (!verify(cfg.workerSharedSecret, ts, callId, sig)) {
    return { error: "bad signature" };
  }
  // Replay guard runs LAST, so an unauthenticated probe can never consume a
  // replay slot (it fails the signature check first).
  if (replay && !replay.claim(callId, ts, sig)) {
    return { error: "replayed handshake" };
  }
  return { callId };
}

/**
 * Best-effort remote-IP key for the per-IP connection cap. StandIn is a hosted
 * service dialing from a small set of egress IPs, and a reverse proxy/LB collapses
 * every client to its own address - so keying on socket.remoteAddress alone makes
 * the per-IP cap either useless (all one IP) or a footgun (throttles all calls).
 * When `trustProxy` is set, use the FIRST X-Forwarded-For hop instead. Only enable
 * it behind a proxy you control (the header is client-spoofable otherwise).
 */
function remoteKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * What startServer returns: the http.Server, plus a graceful drain for
 * embedders. handleSignals is CLI-only (it exits the process); a library host
 * calls `await server.drain()` on its own shutdown path instead - closing the
 * raw server without draining would hard-cut every live call.
 */
export interface BridgeServer extends Server {
  /**
   * End every live call gracefully (session.end + close both sockets), letting
   * a goodbye already in progress finish, and resolve once all sessions have
   * torn down (bounded by the worst-case goodbye deadline). Does NOT stop the
   * listener and never exits the process - follow with server.close().
   */
  drain(reason?: string): Promise<void>;
}

/** Options for startServer beyond the env-driven config. */
export interface StartServerOptions {
  /**
   * Wire SIGTERM/SIGINT to a graceful drain THAT EXITS THE PROCESS. Default
   * false: a library must never call process.exit on its host - only the CLI
   * (which owns the process) enables this. Embedders handle their own signals
   * and call the sessions' shutdown via closing the server.
   */
  handleSignals?: boolean;
}

// SIGTERM/SIGINT drain: on shutdown, gracefully end every live call (notify the
// worker with session.end + close both sockets) instead of hard-dropping calls
// on a redeploy. OPT-IN (CLI only): exits the process when done. Wired exactly
// once per process (the signalsWired guard below; process.on, NOT process.once,
// because a SECOND signal during the drain must be seen and exit immediately).
const liveRegistries = new Set<Map<string, CallSession>>();
let signalsWired = false;
let draining = false;
// Worst-case wait for sessions mid-goodbye (session.shutdown defers to the
// goodbye's own hard-bounded backstop). Raised by startServer to cover the
// configured grace + the hard cap.
let drainDeadlineMs = SHUTDOWN_GRACE_MS;
function wireDrainSignals(): void {
  if (signalsWired) {
    return;
  }
  signalsWired = true;
  const drain = (sig: string): void => {
    // A second signal during the drain grace means the operator wants OUT NOW
    // (a process.once handler would silently ignore it and keep waiting).
    if (draining) {
      log.warn(`${sig} received again during drain; exiting immediately`);
      process.exit(1);
    }
    draining = true;
    const sessions = [...liveRegistries].flatMap((m) => [...m.values()]);
    log.info(`${sig}: draining ${sessions.length} live call(s)`);
    for (const s of sessions) {
      try {
        s.shutdown("bridge-shutdown");
      } catch {
        /* keep draining the rest */
      }
    }
    if (sessions.length === 0) {
      setTimeout(() => process.exit(0), 0);
      return;
    }
    // shutdown() queues session.end + starts the close handshakes asynchronously,
    // and a session mid-goodbye is left to finish (its backstop tears it down) -
    // exiting after a flat grace would truncate the goodbye the caller is still
    // hearing. Poll until every session closed, bounded by the worst-case
    // goodbye deadline, then a short flush window.
    const deadline = Date.now() + drainDeadlineMs;
    const poll = setInterval(() => {
      const stillOpen = [...liveRegistries].flatMap((m) => [...m.values()]).some((s) => !s.isClosed);
      if (!stillOpen || Date.now() > deadline) {
        clearInterval(poll);
        setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
      }
    }, 50);
    poll.unref?.();
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}

export function startServer(
  cfg: BridgeConfig,
  connectLine?: LineConnector,
  options?: StartServerOptions,
): BridgeServer {
  const maxConnections = cfg.maxConnections > 0 ? cfg.maxConnections : DEFAULT_MAX_CONNECTIONS;
  // Per-IP cap defaults to the TOTAL cap (i.e. effectively off) rather than a low
  // fixed number: the bridge's only legitimate client is StandIn, which dials from
  // a small set of IPs, so a low per-IP cap would silently throttle total concurrent
  // calls. Set MAX_CONNECTIONS_PER_IP explicitly (with TRUST_PROXY_XFF when behind
  // a proxy) if you want a real per-IP limit.
  const maxPerIp = cfg.maxConnectionsPerIp > 0 ? cfg.maxConnectionsPerIp : maxConnections;
  const preStartTimeoutMs = cfg.preStartTimeoutMs > 0 ? cfg.preStartTimeoutMs : DEFAULT_PRE_START_TIMEOUT_MS;
  const replay = new ReplayGuard(cfg.hmacFreshnessMs);

  let openConnections = 0;
  const perIp = new Map<string, number>();
  // Live calls keyed by callId: rejects a duplicate callId (a fresh handshake
  // for an already-live call would otherwise open a SECOND billed Line stream
  // for the same call) and backs the SIGTERM drain.
  const sessions = new Map<string, CallSession>();
  liveRegistries.add(sessions);
  if (options?.handleSignals) {
    // Cover a goodbye that starts just before the signal lands.
    drainDeadlineMs = Math.max(drainDeadlineMs, cfg.goodbyeGraceMs + 8_000 + 500);
    wireDrainSignals();
  }

  const onRequest = (req: IncomingMessage, res: import("node:http").ServerResponse): void => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(renderMetrics());
      return;
    }
    res.writeHead(404);
    res.end();
  };

  // Native TLS (wss) when both cert + key are provided; otherwise plain WS, which
  // MUST be fronted by a TLS terminator (tunnel / ingress / LB) - caller audio and
  // video would otherwise cross the wire in plaintext.
  let httpServer: Server;
  if (cfg.tlsCertPath && cfg.tlsKeyPath) {
    httpServer = createHttpsServer(
      // never negotiate down to TLS 1.0/1.1
      { cert: readFileSync(cfg.tlsCertPath), key: readFileSync(cfg.tlsKeyPath), minVersion: "TLSv1.2" },
      onRequest,
    ) as unknown as Server;
    log.info("native TLS enabled (wss)");
  } else {
    httpServer = createServer(onRequest);
    log.warn("no TLS_CERT_PATH/TLS_KEY_PATH: serving plain WS - front this with a TLS terminator in production");
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

  // WS-level heartbeat: a half-open worker socket (NAT drop, peer crash) delivers
  // neither a close nor data. Ping every 30 s and terminate a client that missed
  // the previous pong, so a dead socket is reclaimed in ~1 interval instead of
  // waiting out the session idle timer (during which the callId 409-blocks
  // reconnects). Parity with the Python siblings' aiohttp heartbeat=30.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const c = client as WebSocket & { isAlive?: boolean };
      if (c.isAlive === false) {
        c.terminate();
        continue;
      }
      c.isAlive = false;
      try {
        c.ping();
      } catch {
        /* socket already closing */
      }
    }
  }, WORKER_HEARTBEAT_MS);
  heartbeat.unref?.();

  const reject = (socket: Duplex, status: string, reason: string, ip: string): void => {
    log.warn(`rejected upgrade from ${ip}: ${reason}`);
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };

  httpServer.on("upgrade", (req, socket, head) => {
    const ip = remoteKey(req, cfg.trustProxy);
    // Defense in depth: any throw in this listener is an uncaught exception that
    // kills the process (callIdFromUrl is guarded, but never rely on one guard).
    try {
      processUpgrade(req, socket, head, ip);
    } catch (err) {
      log.error(`upgrade handler threw: ${(err as Error).message}`);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  });

  function processUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): void {
    // Cheap caps first (before HMAC) so a flood can't force expensive crypto.
    if (openConnections >= maxConnections) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "server connection cap reached", ip);
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "per-IP connection cap reached", ip);
    }
    const auth = authorizeUpgrade(cfg, req, replay);
    if ("error" in auth) {
      metricInc("bridge_upgrades_rejected_auth_total");
      return reject(socket, "401 Unauthorized", auth.error, ip);
    }
    // A live session already owns this callId - a retry/rollout reconnect. Reject
    // rather than spin up a second billed agent session for one call.
    if (sessions.has(auth.callId)) {
      metricInc("bridge_upgrades_rejected_duplicate_total");
      return reject(socket, "409 Conflict", `callId ${auth.callId.slice(0, 12)}... already has a live session`, ip);
    }
    // Claim the connection slots BEFORE the async handleUpgrade callback runs -
    // a burst of simultaneous upgrades could otherwise all pass the cap checks
    // above and transiently exceed the caps. Released exactly once, whether the
    // ws is adopted (its close event) or the raw socket dies un-adopted.
    openConnections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let released = false;
    const releaseSlots = (): void => {
      if (released) {
        return;
      }
      released = true;
      openConnections = Math.max(0, openConnections - 1);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) {
        perIp.delete(ip);
      } else {
        perIp.set(ip, n);
      }
    };
    socket.once("close", releaseSlots); // covers the never-adopted path

    // ws's handleUpgrade callback runs synchronously, so the duplicate-callId
    // check above and the registration below cannot interleave with another
    // upgrade for the same callId (no await between them).
    wss.handleUpgrade(req, socket, head, (ws) => {
      const alive = ws as WebSocket & { isAlive?: boolean };
      alive.isAlive = true;
      ws.on("pong", () => {
        alive.isAlive = true;
      });
      log.info(`worker connected for call ${auth.callId.slice(0, 12)}... (${openConnections}/${maxConnections})`);
      metricInc("bridge_calls_total");
      metricInc("bridge_calls_active");

      const session = new CallSession(
        cfg,
        ws,
        auth.callId,
        connectLine,
        () => sessions.delete(auth.callId), // evict on teardown (dedup + drain registry)
      );
      sessions.set(auth.callId, session);

      // Drop a worker that authenticates but never STARTS a call. The timer asks
      // the session whether session.start actually arrived - clearing on the
      // first message of any type would let an authenticated client hold the
      // socket forever by sending pings.
      const preStartTimer = setTimeout(() => {
        if (!session.hasStarted) {
          log.warn(`call ${auth.callId.slice(0, 12)}... sent no session.start in ${preStartTimeoutMs}ms; closing`);
          try {
            ws.close(1008, "no session.start");
          } catch {
            /* already closing */
          }
        }
      }, preStartTimeoutMs);
      preStartTimer.unref?.();

      ws.once("close", () => {
        clearTimeout(preStartTimer);
        metricDec("bridge_calls_active");
        releaseSlots();
      });
    });
  }

  httpServer.on("close", () => {
    clearInterval(heartbeat);
    liveRegistries.delete(sessions);
  });

  const bridge = httpServer as BridgeServer;
  bridge.drain = async (reason = "bridge-shutdown"): Promise<void> => {
    const live = [...sessions.values()];
    for (const s of live) {
      try {
        s.shutdown(reason); // defers to an in-progress goodbye (its backstop tears down)
      } catch {
        /* keep draining the rest */
      }
    }
    if (live.length === 0) {
      return;
    }
    const deadline = Date.now() + Math.max(SHUTDOWN_GRACE_MS, cfg.goodbyeGraceMs + 8_000 + 500);
    while ([...sessions.values()].some((s) => !s.isClosed) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // teardown queues session.end + close handshakes asynchronously; give them
    // a short window to flush before the caller stops the listener.
    await new Promise((r) => setTimeout(r, 100));
  };

  httpServer.listen(cfg.port, cfg.host, () => {
    log.info(
      `cartesia-msteams-bridge listening on ${cfg.host}:${cfg.port} ` +
        `(Line agent ${cfg.agentId}, host ${cfg.apiHost})`,
    );
  });
  return bridge;
}
