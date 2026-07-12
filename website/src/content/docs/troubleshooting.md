---
title: "Troubleshooting"
description: "The errors you will actually see on the upgrade, on the call, and at startup, and what each one means."
---

## `401` on the upgrade

The HMAC handshake failed. Causes:

- **Secret mismatch** - `WORKER_SHARED_SECRET` does not equal the value StandIn holds from pairing. They must match exactly.
- **Clock skew** - the timestamp is outside the freshness window (`HMAC_FRESHNESS_MS`, default 60 s). Sync the clocks (NTP).
- **Replayed handshake** - the same `(callId, ts, sig)` tuple was already used. This is the single-use guard doing its job; a genuine retry uses a fresh timestamp.
- **Secret unset** - the bridge fails closed if `WORKER_SHARED_SECRET` is empty; every upgrade is rejected.

## `409` Conflict

A live session already owns that call id (a retry or rollout reconnect). The bridge rejects the duplicate so it does not open a second billed agent stream for one call. It clears when the first session tears down (a silent dead peer clears after the 90 s idle window).

## `503` Service Unavailable

A connection cap was hit: `MAX_CONNECTIONS` (default 64) or `MAX_CONNECTIONS_PER_IP` (default = the total cap). Raise them for a busier deployment, or check for a client that is not closing sockets.

## Call connects, then `agent-unavailable`

The bridge could not open (or configure) the Line stream. The log line carries the underlying error. Common causes:

- `CARTESIA_API_KEY` is invalid (the access-token mint fails with an HTTP status).
- `CARTESIA_AGENT_ID` does not exist or is not deployed (the socket rejects or closes before open).
- **No `ack` within 10 s** - the server accepted the socket but never confirmed the `start`. Check the agent's deployment status in your Cartesia dashboard.

## First call sounds wrong (garbled or silent)

Look for this log line right after the ack:

```text
INFO  [call:...] first agent audio frame: 640 bytes (20ms if pcm_16000)
```

This is the **output-format tripwire**. The bridge pins the stream to `pcm_16000` and Cartesia's docs imply agent audio returns in the same format, but they stop short of stating it. If the first frame warns about an odd byte length, or the frame sizes do not look like clean 16 kHz frame durations, the agent is emitting a different format - check your Line agent's audio configuration and raise it with Cartesia support.

## Governor fires but the caller hears silence before the drop

`MAX_CALL_MINUTES` (or a StandIn cutoff) triggered, but no deterministic goodbye is configured. Without `CARTESIA_TTS_MODEL` + a voice id, the bridge can only send a `goodbye_request` custom event, which your Line agent code must handle to produce speech. The startup log warns about exactly this combination. Set `CARTESIA_TTS_MODEL` and `CARTESIA_TTS_VOICE_ID` for a spoken goodbye, or handle the event in agent code.

## Call ends with `goodbye-timeout`

A goodbye was spoken (StandIn-side `assistant.say`) but nobody tore the call down within the grace window plus the hard cap. This is the bridge's backstop doing its job; check the StandIn connection if it recurs.

## Governor never fires

`MAX_CALL_MINUTES` must be a number. A non-numeric or negative value stops startup with a clear error (numeric env vars fail loud), so if the process started, the value parsed. Confirm it is greater than `0` (`0` disables the governor).

## Startup error about the Cartesia host

`CARTESIA_API_HOST` is restricted to `*.cartesia.ai` so the API key can only be sent to Cartesia. Use the default; set `CARTESIA_HOST_ALLOW_ANY=true` only for a proxy you control.

## The agent never reacts to DTMF / context events

DTMF and `call_context` / `goodbye_request` events are delivered to your **agent code** on Cartesia's platform (custom events arrive as `UserCustomSent`). If the agent does not react, the handling belongs in your Line agent - see [Your Line Agent](/cartesia-msteams-bridge/your-line-agent/) for the shapes.

## Port already in use

The CLI prints a friendly hint on `EADDRINUSE`. Set `PORT` to a free port.

## Where the logs are

The bridge logs one line per event to stdout/stderr, scoped by call id. Set `LOG_LEVEL=debug` for the verbose relay detail (an invalid value falls back to `info`).
