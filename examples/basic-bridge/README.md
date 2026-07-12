# basic-bridge example

A minimal, runnable embedding of `@komaa/cartesia-msteams-bridge`.

```bash
npm install
cp ../../.env.example .env   # fill in CARTESIA_API_KEY, CARTESIA_AGENT_ID and WORKER_SHARED_SECRET
npm start
```

The bridge listens on `PORT` (default 8080). Point your StandIn identity's agent
WebSocket URL at `wss://<your-host>/voice/msteams/stream` (front it with TLS, or set
`TLS_CERT_PATH`/`TLS_KEY_PATH`), call your bot in Microsoft Teams, and talk to your
Line agent.

There is deliberately no tool or vision wiring here: the agent's brain is your Line
agent code on Cartesia's platform. The bridge forwards live call context to it as
`custom` events (`call_context`, `goodbye_request`) - the shapes are documented in
the [package README](../../README.md).
