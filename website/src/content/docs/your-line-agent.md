---
title: "Your Line Agent"
description: "What your Line agent code receives from Teams calls through this bridge: start metadata, call_context and goodbye_request custom events, native DTMF, and the transfer_call limitation."
---

A Line agent is your code deployed on Cartesia's platform. When a Teams call arrives through this bridge, everything below reaches it through Cartesia's normal Line surfaces - the start metadata and `UserCustomSent` events. This page is the contract to build against.

## Detecting a Teams call

The bridge always sets `from: "msteams"` in the start metadata, so your agent code can branch on the transport:

```json
{
  "from": "msteams",
  "callId": "19:meeting_...",
  "callerName": "Alice W",
  "tenantId": "72f9...",
  "direction": "inbound"
}
```

`callerName`, `tenantId` and `direction` are always present (defaulted to `"caller"` / `"unknown-tenant"` / `"inbound"` when Teams provides no identity - guest and anonymous callers exist).

## Live context (`custom` events)

The bridge forwards call state as `custom` events with `type: "call_context"`. Each carries a human-readable `note` (drop it straight into your context if you like) plus structured fields:

```json
{ "type": "call_context", "note": "Call context snapshot at stream start.", "participantCount": 1, "recordingStatus": "unknown" }
{ "type": "call_context", "note": "There are 3 human participants on this call. Stay quiet unless directly addressed.", "participantCount": 3 }
{ "type": "call_context", "note": "The person now speaking is Sara.", "activeSpeaker": "Sara" }
{ "type": "call_context", "note": "Teams recording is now active.", "recordingStatus": "active" }
```

Notes on semantics:

- **One snapshot at stream start** (the first example) carries the participant count and recording state the call began with, so state that changed before the stream was ready is never lost.
- **Active speaker** is only sent in group calls, only when the speaker changes, and rate-limited (at most one update per 5 s) so VAD flapping cannot spam your agent.
- **Recording state** matters if your agent persists anything: Teams tenants often require recording to be active before content is stored. The bridge forwards the signal; the policy is yours to implement in agent code.

## Governor goodbyes (`goodbye_request`)

When a call hits a time limit (StandIn tier cutoff or the bridge's `MAX_CALL_MINUTES` cap) and **no TTS goodbye is configured on the bridge**, your agent code receives:

```json
{ "type": "goodbye_request", "text": "I'm sorry, we've reached the time limit for this call. Goodbye!" }
```

Handle it by speaking the text; the bridge ends the call after the grace window either way, so an unhandled event means the caller hears silence before the drop. If the bridge has `CARTESIA_TTS_MODEL` + a voice configured, the goodbye is synthesized deterministically instead and your agent is muted while it plays - no event is sent.

## DTMF

Keypad digits arrive as native Line `dtmf` events (`0-9`, `*`, `#`) - the bridge does not translate them into prompt text.

## Hanging up

End the call from your agent code the way Line normally ends calls; when the stream closes, the bridge ends the Teams call with `session.end(agent-disconnected)`.

## Known limitation: `transfer_call`

If your agent yields a transfer, the bridge logs it and **ignores it**: there is no phone number to transfer a Teams call to, and the StandIn wire currently has no Teams-side transfer/escalation capability. Disable transfer paths for calls with `metadata.from == "msteams"`.

## Audio format

The stream is pinned to `pcm_16000` (16 kHz, 16-bit, mono). Your agent's audio comes back over the same stream config - see the note in [Troubleshooting](/cartesia-msteams-bridge/troubleshooting/#first-call-sounds-wrong-garbled-or-silent) about the first-frame tripwire.
