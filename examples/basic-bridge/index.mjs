/**
 * basic-bridge example: embed @komaa/cartesia-msteams-bridge in your own project.
 *
 * What it shows:
 *   1. loadConfig()  - the same env variables as the CLI (see ../../.env.example)
 *   2. startServer() - the HTTP + WebSocket server StandIn dials into
 *
 * Unlike the sibling bridges, there are no tool or vision hooks to wire here:
 * a Cartesia Line agent's brain (LLM, tools, conversation logic) is YOUR CODE
 * deployed on Cartesia's platform - this bridge is the Teams transport for it.
 * Live call context (participants, active speaker, recording state, governor
 * goodbyes) reaches your agent code as `custom` events; see the README.
 *
 * Run:  npm install && cp ../../.env.example .env  (fill it in)  && npm start
 *
 * With dummy env values the bridge starts and listens fine; a real Teams call
 * additionally needs a StandIn identity pointed at this server (see README.md).
 */
import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";

// 1. Env-driven config, identical to the CLI. Throws a clear error when a
//    required variable is missing or a numeric one is not a number.
const cfg = loadConfig();

// 2. Start the bridge. StandIn dials {your-url}/{callId} per call with an
//    HMAC-signed upgrade; one Line agent stream is opened per call (a fresh
//    short-lived access token is minted for each).
//    handleSignals: true opts into the built-in SIGINT/SIGTERM drain, which
//    ends every live call cleanly (letting an in-progress goodbye finish) and
//    THEN EXITS THE PROCESS - only enable it when the bridge owns the process.
startServer(cfg, undefined, { handleSignals: true });

console.log("basic-bridge example is up.");
console.log(`Point your StandIn identity's agent WebSocket URL at ws://<this-host>:${cfg.port}/voice/msteams/stream`);
