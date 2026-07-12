# Contributing

Thanks for helping improve `@komaa/cartesia-msteams-bridge`.

## Local setup

```bash
git clone https://github.com/komaa-com/cartesia-msteams-bridge.git
cd cartesia-msteams-bridge
npm install
npm test          # node:test suites via tsx (no network, no API key needed)
npm run typecheck # tsc --noEmit (strict)
npm run dev       # run the bridge from source (env-configured)
```

## Conventions

- TypeScript strict mode; ESM (`type: "module"`); one runtime dependency (`ws`). Please do not add runtime dependencies without discussing first.
- Tests use `node:test` and a fake `AgentPort` (see `test/session.test.ts`) so no Cartesia account is needed to run the suite.
- The relay is copy-only at 16 kHz (the Line stream is pinned to `pcm_16000` and agent audio returns in the same format); the provider adapter (`cartesia.ts`) owns the event framing, and the base64 payload must stay untouched on the hot path. Keep that boundary.
- The wire contract with the StandIn media bridge (`protocol.ts`, `hmac.ts`) is shared with the sibling bridges; changes there need to stay interoperable.
- Error paths matter: a malformed frame from either peer must never throw out of a WebSocket listener (that would take down every live call).

## Release flow (maintainers)

1. Bump `version` in `package.json` and commit.
2. Tag `vX.Y.Z` and push the tag; the publish workflow verifies tag == version, runs typecheck + tests + build, and publishes to npm with provenance.
