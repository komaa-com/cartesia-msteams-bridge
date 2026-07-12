---
title: "Configuration Reference"
description: "Every environment variable the bridge reads, with defaults and meaning."
---

The bridge is configured entirely from environment variables. The package ships a fully commented [`.env.example`](https://github.com/komaa-com/cartesia-msteams-bridge/blob/main/.env.example). Only three variables are required - the agent itself (LLM, tools, conversation logic) is configured where it lives, in your Line deployment on Cartesia.

## Required

| Env | Meaning |
|---|---|
| `WORKER_SHARED_SECRET` | The shared secret from StandIn pairing. Must equal what StandIn holds, or the HMAC upgrade is rejected with `401`. |
| `CARTESIA_API_KEY` | Server-side Cartesia key: mints per-call access tokens and calls Sonic TTS. Never rides the agent socket. |
| `CARTESIA_AGENT_ID` | The deployed Line agent that answers calls (`wss://{host}/agents/stream/{agentId}`). |

## Per-call overrides (optional)

Your Line agent's own deployment config is the default; these override per call:

| Env | Default | Meaning |
|---|---|---|
| `CARTESIA_VOICE_ID` | unset | Override the agent's TTS voice (start `config.voice_id`). |
| `CARTESIA_INTRODUCTION` | unset | Deterministic opening line (start `agent.introduction`) - also the natural place for a spoken AI disclosure. |
| `CARTESIA_SYSTEM_PROMPT` | unset | Prompt override (start `agent.system_prompt`). When set, per-call caller context (name, tenant, direction) is appended; unset = the deployed agent's prompt, untouched. Caller context reaches your agent code via the start metadata either way. |
| `CARTESIA_API_HOST` | `api.cartesia.ai` | REST + agent WebSocket host. Restricted to `*.cartesia.ai`; `CARTESIA_HOST_ALLOW_ANY=true` only for a proxy you control. |
| `CARTESIA_VERSION` | `2025-04-16` | `Cartesia-Version` header sent on every request. |

:::caution
`CARTESIA_API_KEY` authenticates the token mint and the TTS call against `CARTESIA_API_HOST`. The host is allowlisted to `*.cartesia.ai` precisely so a mistyped or attacker-influenced host cannot exfiltrate the key.
:::

## Call governor

| Env | Default | Meaning |
|---|---|---|
| `MAX_CALL_MINUTES` | `0` (off) | Bridge-side hard cap per call, in minutes (fractional allowed). Cartesia knows nothing about your budget - enforce limits here. |
| `GOODBYE_TEXT` | a default line | The goodbye the bridge-side governor speaks. |
| `GOODBYE_GRACE_MS` | `8000` | How long to let the goodbye play out before ending the call when its duration is unknown (the `goodbye_request` fallback). Always hard-bounded. |
| `CARTESIA_TTS_MODEL` | unset | Enables the deterministic goodbye via standalone Sonic TTS (exact text, agent muted, real duration honored, frames never dropped under backpressure). E.g. `sonic-2`. |
| `CARTESIA_TTS_VOICE_ID` | unset | Voice for the goodbye TTS; falls back to `CARTESIA_VOICE_ID`. |
| `CARTESIA_TTS_LANGUAGE` | `en` | Language for the goodbye TTS. |

Without a TTS model + voice, the governor goodbye is a `custom` `{type: "goodbye_request"}` event your Line agent code may speak - silent otherwise. Arming `MAX_CALL_MINUTES` without TTS logs a startup warning for exactly this reason. See [Your Line Agent](/cartesia-msteams-bridge/your-line-agent/).

## Server and transport

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port the bridge listens on. |
| `BIND` | `0.0.0.0` | Bind address. |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | unset | PEM cert/key for native TLS (`wss://`, TLS 1.2 minimum). Without both, the bridge serves plain WS and MUST be fronted by a TLS terminator. |
| `HMAC_FRESHNESS_MS` | `60000` | Allowed clock skew for the HMAC timestamp. Must be positive (0 would reject every upgrade and disable replay protection - fails loud). |
| `MAX_CONNECTIONS` | `0` (= 64) | Max concurrent connections. |
| `MAX_CONNECTIONS_PER_IP` | `0` (= `MAX_CONNECTIONS`) | Per-IP cap. Defaults to the total cap (effectively off) because StandIn dials from a small set of IPs; set explicitly (with `TRUST_PROXY_XFF=true` behind a proxy you control) for a real limit. |
| `TRUST_PROXY_XFF` | `false` | Key the per-IP cap on the first `X-Forwarded-For` hop. Only behind a proxy you control. |
| `PRE_START_TIMEOUT_MS` | `0` (= 10000) | Drop a connection that authenticates but never sends `session.start`. |
| `WORKER_IDLE_TIMEOUT_MS` | `0` (= 90000) | Dead-peer window: end the call after this long without any worker message (the worker heartbeats every 30 s). Frees the call id for reconnect and closes the billed agent stream. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. An invalid value falls back to `info`. |

The bridge also exposes `GET /metrics` (Prometheus text format, no auth): calls total/active, a call-duration **histogram** (`bridge_call_duration_seconds`, for p50/p95/p99) plus the cumulative seconds counter, upgrade rejections by cause, frames relayed each way, backpressure drops, agent connect failures, and agent error events. Like `/healthz` it is served on the same port - keep the port private to your network or scrape through your ingress.

:::note
Configuration **fails loud**: non-numeric or negative numerics, a non-`cartesia.ai` host, or a zero `HMAC_FRESHNESS_MS` all stop startup with a clear message rather than silently misbehaving.
:::

Audio formats are not configurable: the wire is PCM 16 kHz by contract and the Line stream is pinned to `pcm_16000` (the copy-only property).
