---
title: "Governors and Privacy"
description: "The two call governors, the deterministic Sonic TTS goodbye and its goodbye_request fallback, and the privacy posture of a pure transport."
---

## Two governors

Both governors end a call gracefully - the caller hears a goodbye rather than a sudden drop, whenever a spoken path exists.

### StandIn-side (tier limits)

When a StandIn tier limit is reached (a sandbox/free daily cap or a subscription max-minutes governor), StandIn sends an `assistant.say` with the goodbye text. The bridge speaks it and StandIn tears the call down. If StandIn ever fails to hang up afterwards, the bridge's own backstop ends the call after the goodbye grace plus a hard cap - a call can never sit open with the agent muted.

### Bridge-side (`MAX_CALL_MINUTES`)

Because Cartesia knows nothing about your budget, the bridge can enforce its own hard cap. Set `MAX_CALL_MINUTES` (fractional allowed; `0` disables it). At call start the bridge arms a timer; on expiry it flushes playback, speaks `GOODBYE_TEXT`, and ends the call with reason `time-limit`.

## The goodbye: deterministic or delegated

The Line wire has no "make the agent say this exact text" message, so there are two paths:

- **Deterministic (recommended):** set `CARTESIA_TTS_MODEL` + `CARTESIA_TTS_VOICE_ID` (or reuse `CARTESIA_VOICE_ID`). The exact `GOODBYE_TEXT` is synthesized via standalone Sonic TTS, the agent is hard-muted while it plays, the real audio duration is used for the grace, and the goodbye frames are **never dropped** under worker backpressure - the last thing the caller hears is load-bearing. Teardown additionally waits (bounded) for the send buffer to drain so the close handshake cannot cut the goodbye short.
- **Delegated:** without TTS config, the bridge emits a `custom` `{type: "goodbye_request", text}` event. Your Line agent code may speak it; an agent that ignores it means silence before the drop. `loadConfig()` warns at startup when the governor is armed without TTS.

Both paths are backstopped: a hard-bounded teardown deadline is armed before the goodbye is awaited, and the Sonic fetch is time-bounded, so a hung synth can never wedge a call open. If both governors fire at once, the first goodbye wins - the bridge never speaks two.

## Privacy posture

This bridge is a pure transport, which keeps its privacy surface small:

- **No transcripts.** The Line wire carries no transcript events, and the bridge logs none.
- **No video.** `video.frame` messages from the worker are dropped, not buffered - there is no vision path on this wire.
- **Recording state is forwarded, not enforced.** Teams' `recording.status` reaches your agent code as `call_context` events (including a snapshot at stream start); if your tenant requires recording before content is persisted, implement that policy in your Line agent code, which is where persistence happens.
- **Key hygiene.** `CARTESIA_API_KEY` is used only over HTTPS to `*.cartesia.ai` (token mint + TTS); each agent socket authenticates with a short-lived, agent-scoped access token.

Caller audio and the call metadata transit Cartesia's platform per your Cartesia data settings. Disclose that an AI is on the call - a spoken `CARTESIA_INTRODUCTION` is the simplest way, and follows most tenants' AI-disclosure policy.
