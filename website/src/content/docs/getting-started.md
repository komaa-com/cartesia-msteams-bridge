---
title: "Getting Started"
description: "Install the bridge, configure the three required variables, connect a StandIn identity, and make your first Teams call to a Cartesia Line agent."
---

By the end of this page your Cartesia Line agent answers a Microsoft Teams call. You need Node.js `>= 20`, a Cartesia API key, a **deployed Line agent** (its agent id), and a StandIn identity (the sandbox is enough).

The agent itself - LLM, tools, conversation logic - is your code on Cartesia's platform ([docs.cartesia.ai/line](https://docs.cartesia.ai/line)); this bridge is the Teams transport for it.

## 1. Install and run the bridge

As a CLI:

```bash
CARTESIA_API_KEY=sk_car_... \
CARTESIA_AGENT_ID=agent_... \
WORKER_SHARED_SECRET=... \
  npx @komaa/cartesia-msteams-bridge
```

Or embedded in your own project:

```bash
npm install @komaa/cartesia-msteams-bridge
```

```ts
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";

startServer(loadConfig()); // same env variables as the CLI
```

Every option is an environment variable; the package ships a fully commented [`.env.example`](https://github.com/komaa-com/cartesia-msteams-bridge/blob/main/.env.example), and the [Configuration Reference](/cartesia-msteams-bridge/configuration-reference/) documents each one. The bridge listens on `0.0.0.0:8080` by default and exposes `GET /healthz` for liveness checks. The CLI reads `process.env` only - use `node --env-file=.env` for a `.env` file.

`WORKER_SHARED_SECRET` comes from StandIn in the next step.

## 2. Shape the call (optional)

Your Line agent's own deployment config is the default; these override per call:

```bash
CARTESIA_INTRODUCTION="Hello! You've reached Komaa. Quick note: I'm an AI assistant."
CARTESIA_VOICE_ID=a0e99841-438c-4a64-b679-ae501e7d6091
CARTESIA_SYSTEM_PROMPT="You are Komaa's friendly receptionist. Keep replies short."
```

The bridge always passes caller context (name, tenant, direction) to your agent code in the start metadata, and appends it to `CARTESIA_SYSTEM_PROMPT` when you set one. See [Your Line Agent](/cartesia-msteams-bridge/your-line-agent/) for everything your agent receives.

## 3. Connect a StandIn identity

StandIn is the hosted service that joins the Teams call and dials into your bridge. Pick a tier at [standin.komaa.com](https://standin.komaa.com) (sandbox for an instant trial), pair, and you get a **shared secret**.

1. Put the secret in `WORKER_SHARED_SECRET` (both sides must match exactly).
2. Point the identity's **agent WebSocket URL** at your bridge, for example `wss://line-bridge.example.com:8080/voice/msteams/stream`. StandIn appends `/{callId}` per call.
3. Restart the bridge if you changed the env.

StandIn dials in **from the internet**, so a laptop or private host needs a public URL. A tunnel gives you one and terminates TLS (so you get `wss://` for free). Run one pointing at port `8080`, then use the `wss://…/voice/msteams/stream` form of the printed host:

Tailscale Funnel:

```bash
tailscale funnel --bg --https=8080 8080
```

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

ngrok:

```bash
ngrok http 8080
```

VS Code dev tunnels:

```bash
devtunnel host -p 8080 --allow-anonymous
```

For a fixed production host use an ingress/load balancer, or serve TLS natively with `TLS_CERT_PATH` + `TLS_KEY_PATH`. Never give StandIn a plain `ws://` URL outside local testing.

More detail (tiers, what pairing does, cutoff behavior): [Connecting to StandIn](/cartesia-msteams-bridge/connecting-to-standin/).

## 4. Make the first call

Call your Teams bot (or join the sandbox meeting). In the bridge logs you should see the call arrive, the Line stream open, and the relay start:

```text
INFO  [server] worker connected for call 19:meeting_ab... (1/64)
INFO  [call:19:meeting_ab] session.start (direction=inbound, recording=unknown)
INFO  [call:19:meeting_ab] Cartesia Line stream open; waiting for ack
INFO  [call:19:meeting_ab] ack received; relaying
INFO  [call:19:meeting_ab] first agent audio frame: 640 bytes (20ms if pcm_16000)
```

That last line is the **output-format tripwire**: Cartesia's docs imply (but do not state) that agent audio returns in the configured `pcm_16000`. If your first call sounds wrong, this log line is where to look - see [Troubleshooting](/cartesia-msteams-bridge/troubleshooting/).
