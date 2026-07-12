---
title: "Library API"
description: "Embed the bridge in your own Node project: startServer, the BridgeServer drain, custom agent transports for testing, HMAC helpers, protocol types."
---

The package is both a CLI and an importable TypeScript library. Everything below is exported from the package root and fully typed.

```ts
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";
```

## Run the bridge in your own service

`loadConfig()` reads the same environment variables as the CLI and throws a clear error when a required variable is missing or a numeric one is not a number. `startServer(cfg)` returns a `BridgeServer` - the Node `http.Server` plus a graceful `drain()`.

```ts
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";

const server = startServer(loadConfig());
server.on("listening", () => console.log("bridge up"));
```

### Graceful shutdown

Two paths, pick by who owns the process:

- **CLI / the bridge owns the process:** `startServer(cfg, undefined, { handleSignals: true })` wires SIGTERM/SIGINT to a drain that ends every live call, lets an in-progress goodbye finish, and **then exits the process**. A second signal during the drain exits immediately.
- **Embedded in a larger service:** never let a library exit its host - call the handle instead:

```ts
const server = startServer(loadConfig());
// on your shutdown path:
await server.drain();  // ends live calls gracefully; waits for goodbyes; no process.exit
server.close();        // then stop the listener
```

`drain()` resolves once every session has torn down, bounded by the worst-case goodbye deadline. Closing the raw server without draining would hard-cut every live call.

## Custom agent transport (testing)

The second argument to `startServer` is a `LineConnector` - an async factory that returns an `AgentPort`. The default mints an access token and opens a real Line stream; tests substitute a fake so no network or API key is needed.

```ts
import { startServer, loadConfig, type LineConnector, type AgentPort } from "@komaa/cartesia-msteams-bridge";

const fakeConnector: LineConnector = async (_cfg, _log, handlers) => {
  const port: AgentPort = {
    isOpen: true,
    sendStart() {},
    sendAudioChunk() {},
    sendDtmf() {},
    sendCustom() {},
    close() {},
  };
  // push server->bridge events with handlers.onMessage({event: "ack"}) and
  // agent audio with handlers.onAudio(base64Pcm)
  return port;
};

startServer(loadConfig(), fakeConnector);
```

The repository's own [test suite](https://github.com/komaa-com/cartesia-msteams-bridge/tree/main/test) uses exactly this shape.

## Cartesia-side helpers

Exported for tooling and tests:

- `CartesiaAgentSocket` - the real Line socket (per-call token mint, start/ack, keepalive pings).
- `buildStart(opts)` - the `start` event builder (pcm_16000 pinned, overrides only when configured, caller context in metadata).
- `mintAccessToken(cfg)` - POST `/access-token` with `grants: {agent: true}`.
- `synthesizeGoodbye(cfg, text)` - standalone Sonic TTS returning raw 16 kHz PCM.
- `WIRE_SAMPLE_RATE` (16000) and `INPUT_FORMAT` ("pcm_16000").

## HMAC helpers

```ts
import { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER } from "@komaa/cartesia-msteams-bridge";

const ts = Date.now();
const signature = sign(secret, ts, callId); // HMAC-SHA256(secret, `${ts}.${callId}`) hex
// send as headers X-StandIn-Timestamp / -Signature
verify(secret, ts, callId, signature); // constant-time, false on any missing input
isFresh(ts, 60_000);                   // within the freshness window?
```

## Protocol types

All wire message types are exported for building or validating messages: `SessionStartMessage`, `AudioFrameMessage`, `ParticipantsMessage`, `DtmfMessage`, `AssistantSayMessage`, `AssistantCancelMessage`, the `WorkerInbound` / `WorkerOutbound` unions, plus `parseWorkerMessage()` and `pcm16kBytesToMs()`. (`ExpressionMessage` and `DisplayImageMessage` are reserved wire types this bridge never emits - the Line wire has no tool channel to drive them.) See the [Wire Protocol](/cartesia-msteams-bridge/wire-protocol/) for the full contract.

## Also exported

- `authorizeUpgrade`, `callIdFromUrl`, `ReplayGuard` - the upgrade-authorization primitives.
- `CallSession` - the per-call relay class (advanced embedding).
- `renderMetrics`, `logger` - metrics text and the minimal leveled logger.
- Types: `BridgeConfig`, `BridgeServer`, `StartServerOptions`, `LineInbound`, `LineSessionHandlers`, `StartOptions`, `CallerContext`.
