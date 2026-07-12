---
title: "Wire Protocol"
description: "The exact contract on both sockets: the HMAC upgrade, connection guards, every message the bridge relays, and the Line WebSocket mapping."
---

The bridge terminates two protocols: the StandIn media bridge's worker protocol on one side, and the Cartesia Line WebSocket API on the other. This page documents both. The StandIn side is identical to the sibling bridges - the implementations are interchangeable.

## The upgrade (StandIn side)

The StandIn media bridge opens one WebSocket per call to `{path}/{callId}` - the **call id is the last path segment** of the URL. The upgrade carries two headers:

| Header | Value |
|---|---|
| `X-StandIn-Timestamp` | Unix epoch milliseconds |
| `X-StandIn-Signature` | `HMAC-SHA256(secret, "{timestampMs}.{callId}")`, lowercase hex |

The legacy header names `X-OpenClawTeamsBridge-Timestamp` / `-Signature` are still accepted (the bridge checks the new names first); StandIn sends both pairs during the transition.

Verification (`401` on failure): the timestamp must be within the freshness window (`HMAC_FRESHNESS_MS`, default 60 s), the signature must match (constant-time compare), and the `(callId, ts, sig)` tuple must be **single-use** (a captured handshake cannot be replayed within the window). The bridge fails closed if the shared secret is unset. The call id is also cross-checked against the `session.start` body.

## Connection guards

| Guard | Value |
|---|---|
| Max concurrent connections | 64 (`MAX_CONNECTIONS`) |
| Per-IP cap | = total cap (`MAX_CONNECTIONS_PER_IP`) |
| Max inbound frame | 2 MB |
| Outbound backpressure cap | 1 MB (drops hot-path audio above it; control frames and goodbye audio always pass) |
| Pre-start timeout | 10 s (`PRE_START_TIMEOUT_MS`) - drops a socket that never sends `session.start` |
| Worker idle timeout | 90 s (`WORKER_IDLE_TIMEOUT_MS`) - dead-peer detection: ends the call after 3 missed 30 s heartbeats, freeing the call id and the billed agent stream |
| Duplicate call id | rejected with `409` - no second billed agent stream for one call |

Audio on the StandIn wire is base64 **PCM 16 kHz, 16-bit, mono**; toward Cartesia it is the same base64 payload inside `media_input` events - relayed verbatim.

## Worker to bridge

| Message | Fields | Bridge action |
|---|---|---|
| `session.start` | `callId`, `threadId`, `caller{aadId?, displayName?, tenantId?}`, `recordingStatus?`, `direction?` | Mint a per-call access token, open the Line stream, send `start` (pcm_16000, agent overrides when configured, caller context in metadata). All caller fields are nullable and are defaulted, never sent as null. |
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64`, `speakerName?` | Re-wrap the base64 payload as `media_input`, verbatim. **Buffered until the server's `ack`**, then flushed oldest-first. In group calls, a changed `speakerName` becomes a rate-limited `call_context` event. Frames without a payload are dropped. |
| `video.frame` | `source`, `ts`, `width`, `height`, `mime`, `dataBase64`, ... | Dropped - there is no vision path on the Line wire. |
| `participants` | `count` | `custom` `{type: "call_context", participantCount}` event to the agent code. |
| `dtmf` | `digit` | Native Line `dtmf` event. |
| `ping` | `ts` | Reply `pong` with the same `ts`. |
| `recording.status` | `status` | `custom` `{type: "call_context", recordingStatus}` event to the agent code. |
| `assistant.say` | `text` | Governor goodbye: Sonic TTS when configured, else a `goodbye_request` custom event; backstop teardown armed, then StandIn tears the call down. |
| `session.end` | `reason` | Close the Line stream, tear down. |

## Bridge to worker

| Message | Fields | Meaning |
|---|---|---|
| `audio.frame` | `seq`, `timestampMs`, `payloadBase64` | Agent audio for the Teams side (the `media_output` payload, verbatim). |
| `assistant.cancel` | `turnId` | Barge-in (or goodbye flush): flush queued playback on the Teams side. `turnId` is always `0` - the worker's flush ignores the value. |
| `pong` | `ts` | Reply to a worker `ping`. |
| `session.end` | `reason` | Ask StandIn to tear the call down (governor, agent hangup, or fatal error). |

(`expression` and `display.image` exist in the shared wire contract but are never sent by this bridge - the Line wire has no tool channel to drive them.)

## Cartesia Line side (mapping)

Endpoint: `wss://api.cartesia.ai/agents/stream/{agentId}`, authenticated with `Authorization: Bearer <access token>` (minted per call via `POST /access-token` with `grants: {agent: true}`) plus the `Cartesia-Version` header.

| Line event | Direction | Bridge behavior |
|---|---|---|
| `start` | bridge → Line | Sent once, first message: `config.input_format: "pcm_16000"` (+ `voice_id` when overridden), `agent.introduction` / `agent.system_prompt` only when configured, caller context in `metadata`. |
| `ack` | Line → bridge | The stream is confirmed. Flushes buffered caller audio (oldest first) and emits the initial `call_context` snapshot. A 10 s ack timeout ends the call rather than leaving it silent. |
| `media_input` | bridge → Line | Caller audio: the wire's base64 payload, verbatim. |
| `media_output` | Line → bridge | Agent audio: relayed verbatim as `audio.frame`. The first frame's byte length is logged (output-format tripwire; odd length warns). |
| `clear` | Line → bridge | Flush queued playback (barge-in): emit `assistant.cancel`. No ghost filter is needed - `clear` is in-band on the ordered socket, so later frames are genuinely new speech. |
| `dtmf` | bridge → Line | Keypad digits, native. |
| `custom` | bridge → Line | `call_context` and `goodbye_request` events for the agent code (received there as `UserCustomSent`). |
| `transfer_call` | Line → bridge | Logged and ignored (no Teams-side transfer capability on this wire). |
| error object (`type: "error"`) | Line → bridge | Counted (`bridge_agent_errors_total`) and logged; the call survives advisory errors. |
| WS ping | bridge → Line | Protocol-level ping every 60 s (the server closes idle connections after ~180 s). |
