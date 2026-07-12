---
title: "Run the Example"
description: "A guided walkthrough of examples/basic-bridge: what each line does and how to grow it into your own service."
---

The repository ships one example, [`examples/basic-bridge`](https://github.com/komaa-com/cartesia-msteams-bridge/tree/main/examples/basic-bridge) - a complete, working embedding in about 20 lines. This page walks through it so you understand every moving part before writing your own.

## What the example is

A single `index.mjs` that:

1. loads the env-driven config,
2. starts the bridge with `startServer()`,
3. opts into the SIGTERM/SIGINT drain (it owns the process).

That is the whole thing - and that is the point. Unlike the sibling bridges there are no tool or vision hooks to wire: your Line agent's brain lives on Cartesia's platform, and the bridge forwards the Teams context to it automatically ([Your Line Agent](/cartesia-msteams-bridge/your-line-agent/)).

## Run it

```bash
git clone https://github.com/komaa-com/cartesia-msteams-bridge
cd cartesia-msteams-bridge/examples/basic-bridge
npm install
cp ../../.env.example .env    # fill in the three required values
npm start
```

The three values in `.env`:

| Variable | What to put there |
|---|---|
| `CARTESIA_API_KEY` | Your Cartesia API key (server-side only; never rides the agent socket - each call mints a short-lived token). |
| `CARTESIA_AGENT_ID` | The deployed Line agent that should answer calls. |
| `WORKER_SHARED_SECRET` | The shared secret from StandIn pairing - both sides must match exactly. |

Expose port 8080 with a tunnel (see [Getting Started](/cartesia-msteams-bridge/getting-started/)), set your StandIn identity's **agent WebSocket URL** to the `wss://…/voice/msteams/stream` form, and place a Teams call - your Line agent answers.

## The code

```js
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";

const cfg = loadConfig();
startServer(cfg, undefined, { handleSignals: true });

console.log("basic-bridge example is up.");
console.log(`Point your StandIn identity's agent WebSocket URL at ws://<this-host>:${cfg.port}/voice/msteams/stream`);
```

- **`loadConfig()`** reads every setting from environment variables and fails loud on a missing required variable or a non-numeric number - a typo stops startup with a clear message instead of silently misbehaving.
- **`startServer(cfg, undefined, { handleSignals: true })`** starts the WebSocket server. The second argument is the agent connector (tests inject a fake there; production uses the default). `handleSignals: true` wires SIGTERM/SIGINT to a graceful drain that ends every live call cleanly, lets an in-progress goodbye finish, and **then exits the process** - only enable it when the bridge owns the process, as this example does.

## From example to your own service

- Embedding in a larger service? Leave `handleSignals` off and wire your own shutdown to the returned handle: `await server.drain(); server.close();` - see [Library API](/cartesia-msteams-bridge/library-api/).
- Give the agent a deterministic opening line (`CARTESIA_INTRODUCTION`) and set the [governor variables](/cartesia-msteams-bridge/governors-and-privacy/) (`MAX_CALL_MINUTES`, `CARTESIA_TTS_MODEL` + `CARTESIA_TTS_VOICE_ID`, `GOODBYE_TEXT`) before going to production.
- Teach your Line agent code to consume the bridge's `call_context` and `goodbye_request` events - shapes in [Your Line Agent](/cartesia-msteams-bridge/your-line-agent/).
- For tests, inject a fake agent with the `connectLine` argument - see [Library API](/cartesia-msteams-bridge/library-api/).

If you only need the stock behavior, skip the embedding entirely and run the `cartesia-msteams-bridge` CLI.
