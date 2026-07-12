# Microsoft Teams Bridge for Cartesia Line Agents

[![CI](https://github.com/komaa-com/cartesia-msteams-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/komaa-com/cartesia-msteams-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@komaa/cartesia-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/cartesia-msteams-bridge)
[![docs](https://img.shields.io/badge/docs-komaa--com.github.io-2563eb.svg)](https://komaa-com.github.io/cartesia-msteams-bridge/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**`@komaa/cartesia-msteams-bridge`** puts a [Cartesia Line](https://docs.cartesia.ai/line) voice agent on a real **Microsoft Teams call**.

The hosted **StandIn media bridge** ([standin.komaa.com](https://standin.komaa.com)) joins the Teams call and dials into this bridge over an HMAC-authenticated WebSocket; the bridge opens one Line agent stream per call (via Cartesia's [WebSocket API](https://docs.cartesia.ai/line/integrations/websocket-api), the integration Cartesia provides for bringing your own telephony) and relays between them.

```text
Microsoft Teams call
       |
       v
StandIn media bridge        (hosted; joins the call)
       |   HMAC WebSocket, base64 PCM 16 kHz
       v
this bridge                 (you run it)
       |   WebSocket, base64 pcm_16000
       v
Cartesia Line agent         (your agent code on Cartesia's platform)
```

The hot path is **copy-only in the strongest sense**: the StandIn wire is base64 PCM 16 kHz mono, the Line stream is pinned to `pcm_16000`, and agent audio returns in the same format - so the base64 payload string is relayed **verbatim** in both directions. No decode, no re-encode, no resampling, no transcoding.

> **One wire assumption to verify on your first call.** Cartesia's docs give the stream a single format config and their own quick start plays `media_output` straight back against it, but they stop short of stating "output equals `input_format`" in writing. The bridge logs the first agent frame's byte length (and warns if it cannot be 16-bit PCM) precisely so a format surprise is visible in the logs on your first live call instead of silently reaching the caller as noise. If your first call sounds wrong, that log line is the place to look.

## Where the brain lives (read this first)

A Line agent is **your code deployed on Cartesia's platform**: the LLM, the tools, the conversation logic, the hangup decision - all of it runs there, configured with Cartesia's SDK, not by this bridge. That makes this bridge deliberately a **transport**, and different from its siblings in two ways:

- **No tool registry, no vision hooks.** The Line wire has no client-side tool channel back to the bridge, so tools (`lookup_order`, CRM calls, hangup) belong in your Line agent code. The sibling bridges (ElevenLabs, Deepgram, OpenAI) host tools in-process because those platforms route function calls back over the socket; Line does not.
- **Your agent still gets the Teams context.** The bridge forwards caller identity, participants, active speaker, DTMF and recording state to your agent code via the wire's `metadata` and `custom` events - shapes below.

## Features

- **Realtime voice, end to end** - the caller talks to your Line agent and hears it reply. Turn-taking and interruption are the Line platform's own; the bridge adds nothing to the latency budget beyond a relay hop.
- **Barge-in mapped to Teams** - when Line flushes playback (`clear`), the bridge cancels queued audio on the Teams side with `assistant.cancel`.
- **Per-call personalization** - caller name, tenant and direction ride the `start` metadata for your agent code, and are appended to `CARTESIA_SYSTEM_PROMPT` when you override the prompt. `CARTESIA_INTRODUCTION` gives a deterministic opening line (the natural place for a spoken AI disclosure); `CARTESIA_VOICE_ID` overrides the voice per call.
- **Native DTMF** - keypad digits are forwarded as Line `dtmf` events, not prompt hacks.
- **Live context events** - participants, active-speaker changes (rate-limited) and recording state reach your agent code as `custom` `{type: "call_context"}` events.
- **Per-call access tokens** - the long-lived `CARTESIA_API_KEY` never rides an agent socket: each call mints a short-lived, agent-scoped access token and authenticates the WebSocket with that.
- **Two call governors** - a StandIn-side cutoff the bridge speaks a goodbye for, and a bridge-side `MAX_CALL_MINUTES` hard cap. With `CARTESIA_TTS_MODEL` + a voice id the goodbye is the exact text via standalone Sonic TTS (agent muted while it plays, real duration honored); without TTS the bridge emits a `goodbye_request` custom event your agent code may speak. Both paths are backstopped so a call can never sit open half-dead.
- **Observability** - `GET /healthz` for liveness and `GET /metrics` (Prometheus text format): calls, durations, rejects, relay/drop counters, agent errors.
- **Hardened transport** - replay-proof HMAC upgrade, single-use handshake guard, connection caps, payload caps, backpressure bounds, pre-start timeout, dead-peer detection, duplicate-call rejection, ack-gated audio, graceful signal drain that lets an in-progress goodbye finish, and a `*.cartesia.ai` host allowlist so your API key can only be sent to Cartesia.

## Install

Run it directly:

```bash
npx @komaa/cartesia-msteams-bridge
```

Or add it to your project:

```bash
npm install @komaa/cartesia-msteams-bridge
```

Node.js `>= 20`. One runtime dependency (`ws`).

## Quick start

### 1. As a CLI (env-configured)

Set the three required variables, then run it:

```bash
export CARTESIA_API_KEY=sk_car_...
export CARTESIA_AGENT_ID=agent_...
export WORKER_SHARED_SECRET=...
npx @komaa/cartesia-msteams-bridge
```

Optionally shape the call (your Line agent's own config is the default):

```bash
export CARTESIA_INTRODUCTION="Hello! You've reached Komaa. Quick note: I'm an AI assistant."
export CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091
```

Or keep them in a `.env` file (copy [`.env.example`](./.env.example), which ships with the package) and load it:

```bash
node --env-file=.env node_modules/.bin/cartesia-msteams-bridge
```

(The CLI reads `process.env` only - there is no automatic `.env` loading, so use `--env-file` or your process manager's env handling.)

### 2. As a library

```ts
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";

// env-configured, same variables as the CLI
startServer(loadConfig());
```

Signal handling is opt-in for embedders: the built-in SIGTERM/SIGINT drain ends every live call gracefully (letting an in-progress goodbye finish) and **then exits the process**, so it is only wired when you ask for it (the CLI does). Enable it when the bridge owns the process:

```ts
startServer(loadConfig(), undefined, { handleSignals: true });
```

When the bridge is embedded in a larger service, wire your own shutdown path to the returned handle instead - `drain()` ends every live call gracefully (waiting for an in-progress goodbye) without stopping the listener or exiting:

```ts
const server = startServer(loadConfig());
// on your shutdown path:
await server.drain();
server.close();
```

### 3. Connect it to StandIn

StandIn dials in **from the internet**, so expose port 8080 (tunnel or public host), then register the URL on your identity in the [StandIn dashboard](https://standin.komaa.com/dashboard):

```bash
tailscale funnel --bg --https=8080 8080
# Agent voice URL: wss://<machine>.<tailnet>.ts.net:8080/voice/msteams/stream
```

Place a Teams call to your bot (or join the [sandbox](https://standin.komaa.com/sandbox) meeting). StandIn joins, connects to the bridge, and your Line agent answers.

## What your Line agent receives

Everything below arrives in your agent code through Cartesia's platform, exactly as the Line WebSocket API delivers metadata and custom events.

**Start metadata** (every call):

```json
{
  "from": "msteams",
  "callId": "19:meeting_...",
  "callerName": "Alice W",
  "tenantId": "72f9...",
  "direction": "inbound"
}
```

**Live context** (`custom` events, advisory):

```json
{ "type": "call_context", "note": "There are 3 human participants on this call. Stay quiet unless directly addressed.", "participantCount": 3 }
{ "type": "call_context", "note": "The person now speaking is Sara.", "activeSpeaker": "Sara" }
{ "type": "call_context", "note": "Teams recording is now active.", "recordingStatus": "active" }
```

**Governor goodbye request** (`custom` event, only when no TTS goodbye is configured):

```json
{ "type": "goodbye_request", "text": "I'm sorry, we've reached the time limit for this call. Goodbye!" }
```

Handle it by speaking the text; the bridge ends the call after the grace window either way. On the ack the bridge also sends one `call_context` snapshot (participant count + recording state at stream start), so state that changed before the stream was ready is never lost.

**Known limitation:** `transfer_call` from your agent is logged and **ignored**. There is no phone number to transfer a Teams call to, and the StandIn wire currently has no Teams-side transfer/escalation capability - if your Line agent offers transfers, disable that path for calls arriving with `metadata.from == "msteams"`. DTMF arrives as native Line `dtmf` events.

## Configuration

Two hosts of truth: your Line agent's own deployment config (on Cartesia), and these environment variables for the bridge. Only the first three are required.

| Variable | Default | Meaning |
|---|---|---|
| `CARTESIA_API_KEY` | required | Server-side key: mints per-call access tokens and calls Sonic TTS. Never rides the agent socket. |
| `CARTESIA_AGENT_ID` | required | The deployed Line agent that answers calls. |
| `WORKER_SHARED_SECRET` | required | Shared secret from StandIn pairing; both sides must match exactly. |
| `CARTESIA_VOICE_ID` | unset | Override the agent's TTS voice for calls through this bridge. |
| `CARTESIA_INTRODUCTION` | unset | Deterministic opening line (start `agent.introduction`). |
| `CARTESIA_SYSTEM_PROMPT` | unset | Prompt override (start `agent.system_prompt`); caller context is appended when set. Unset = the deployed agent's prompt, untouched. |
| `CARTESIA_TTS_MODEL` | unset | Sonic model for the deterministic governor goodbye (e.g. `sonic-2`). |
| `CARTESIA_TTS_VOICE_ID` | unset | Voice for the goodbye TTS (falls back to `CARTESIA_VOICE_ID`). |
| `CARTESIA_TTS_LANGUAGE` | `en` | Language for the goodbye TTS. |
| `CARTESIA_API_HOST` | `api.cartesia.ai` | REST + agent WS host. Restricted to `*.cartesia.ai` (`CARTESIA_HOST_ALLOW_ANY=true` to override for a proxy you control). |
| `CARTESIA_VERSION` | `2025-04-16` | `Cartesia-Version` header sent on every request. |
| `MAX_CALL_MINUTES` | `0` (off) | Bridge-side hard cap per call, in minutes (fractional allowed). |
| `GOODBYE_TEXT` | a default line | The goodbye the bridge-side governor speaks. |
| `GOODBYE_GRACE_MS` | `8000` | Grace before `session.end` when the goodbye duration is unknown. Always hard-bounded. |
| `PORT` / `BIND` | `8080` / `0.0.0.0` | Listen address. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | unset | PEM cert/key for native TLS (`wss://`, TLS 1.2+). Without both, front the bridge with a TLS terminator. |
| `HMAC_FRESHNESS_MS` | `60000` | Allowed clock skew for the HMAC timestamp. |
| `MAX_CONNECTIONS` | `0` (= 64) | Max concurrent worker connections. |
| `MAX_CONNECTIONS_PER_IP` | `0` (= total) | Per-IP cap (with `TRUST_PROXY_XFF=true` behind a proxy you control). |
| `PRE_START_TIMEOUT_MS` | `0` (= 10000) | Drop a connection that authenticates but never sends `session.start`. |
| `WORKER_IDLE_TIMEOUT_MS` | `0` (= 90000) | Dead-peer window (the worker heartbeats every 30 s). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

Configuration **fails loud**: non-numeric or negative numerics and a non-`cartesia.ai` host stop startup with a clear message. Setting `MAX_CALL_MINUTES` without a TTS goodbye logs a startup warning (the goodbye would be a `goodbye_request` event only).

Audio formats are not configurable: the wire is PCM 16 kHz by contract and the Line stream is pinned to `pcm_16000` (the copy-only property).

## Call governors

Two governors can end a call gracefully; both try to speak before hanging up:

- **StandIn-side:** when a tier limit is reached, StandIn sends `assistant.say` with the goodbye text; the bridge speaks it and StandIn tears the call down.
- **Bridge-side** (`MAX_CALL_MINUTES` > 0): the bridge arms a timer at call start. On expiry it flushes playback, speaks `GOODBYE_TEXT`, waits for the audio to play out (real TTS duration, or `GOODBYE_GRACE_MS` when unknown, always hard-bounded), then ends the call with reason `time-limit`. Use this when the billing limit lives with you, since Cartesia knows nothing about your budget.

With `CARTESIA_TTS_MODEL` + a voice id the goodbye is deterministic: the exact text via standalone Sonic TTS, the agent hard-muted while it plays, and the goodbye frames are never dropped under worker backpressure (the last thing the caller hears is load-bearing). Without TTS, the bridge emits a `goodbye_request` custom event for your agent code. Both paths are backstopped: if whichever side is supposed to hang up never does, the bridge force-ends the call after the grace plus a hard cap.

## Disconnects and reconnects

If the worker socket drops mid-call, the bridge tears the call down: the Line stream is closed and the `callId` is freed. There is **no mid-call re-attach**: a StandIn retry with the same `callId` after teardown is a fresh call with a fresh agent stream and no conversation memory; a retry arriving while the old session is still live is rejected with `409` so one call can never pay for two agent streams. If the Cartesia socket drops instead (including your agent code ending the call), the bridge ends the Teams call with `session.end(agent-disconnected)` - there is **no mid-call reconnect to Cartesia** either: the connect path retries once at call start, but a steady-state Line blip ends the Teams call. A silent dead peer is detected after 90 s (3 missed worker heartbeats) and the billed stream is closed.

One operational note: the per-call access token is minted with the API's maximum lifetime (1 hour) and the wire has no re-auth message. Whether Cartesia enforces expiry on established streams is not documented; set `MAX_CALL_MINUTES` to 55 or less to end long calls cleanly before that cliff (the bridge warns at startup otherwise).

## Privacy

- The bridge relays audio and forwards call context; it logs no transcripts (the Line wire carries none) and buffers no video (`video.frame` messages are dropped - there is no vision path on this wire).
- Caller audio and the call metadata above transit Cartesia's platform per your Cartesia data settings; disclose the AI on the call via `CARTESIA_INTRODUCTION`.
- The Teams recording state is forwarded to your agent code (`call_context` events) so your Line agent can implement its own recording-gated behavior.

## Repository layout

```
src/
  server.ts      HTTP + WS upgrade, HMAC validation, connection guards, session registry, drain
  session.ts     per-call relay: StandIn WS <-> Line agent WS, context events, governors, goodbye
  cartesia.ts    Line agent socket (start/ack, media events, keepalive), access tokens, Sonic TTS
  protocol.ts    wire message types (JSON, camelCase, discriminated on "type")
  hmac.ts        HMAC-SHA256("{timestampMs}.{callId}") hex, constant-time verify
  config.ts      env config (fail-loud numeric parsing, host allowlist)
examples/        runnable example project
website/         docs site (Astro Starlight), deployed to GitHub Pages
test/            node:test suites (run with tsx; no Cartesia account needed)
```

## Documentation

- **Docs site:** [komaa-com.github.io/cartesia-msteams-bridge](https://komaa-com.github.io/cartesia-msteams-bridge/) - getting started, what your Line agent receives, architecture, configuration and library API reference, wire protocol, troubleshooting.
- **Example project:** [`examples/basic-bridge/`](./examples/basic-bridge/) - a runnable embedding.
- **StandIn (the hosted service):** [standin.komaa.com](https://standin.komaa.com) · [docs.komaa.com](https://docs.komaa.com).
- **Cartesia Line:** [docs.cartesia.ai/line](https://docs.cartesia.ai/line) - deploying agents, the WebSocket API this bridge speaks.
- **Siblings:** the same bridge exists for [ElevenLabs](https://github.com/komaa-com/elevenlabs-msteams-bridge), [LiveKit](https://github.com/komaa-com/livekit-msteams-bridge), [OpenAI Realtime](https://github.com/komaa-com/openai-msteams-bridge), and [Deepgram](https://github.com/komaa-com/deepgram-msteams-bridge) - same wire protocol, same hardening, pick the agent platform that fits.

## Contributing

PRs welcome - see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup and conventions.

## License

[MIT](./LICENSE)
