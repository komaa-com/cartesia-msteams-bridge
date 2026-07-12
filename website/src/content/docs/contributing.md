---
title: "Contributing"
description: "Local setup, conventions, and where the full contributor guide lives."
---

Contributions are welcome. The full guide - local setup, conventions, and the release flow - lives in [`CONTRIBUTING.md`](https://github.com/komaa-com/cartesia-msteams-bridge/blob/main/CONTRIBUTING.md) in the repository.

## Quick start for contributors

```bash
git clone https://github.com/komaa-com/cartesia-msteams-bridge
cd cartesia-msteams-bridge
npm ci
npm test        # node:test suites via tsx (no network, no Cartesia account needed)
npm run typecheck
npm run build
```

- **One runtime dependency** (`ws`); everything else is dev-only.
- **The relay is verbatim at 16 kHz** - the Line stream is pinned to `pcm_16000` and the base64 payload must stay untouched on the hot path; the provider adapter (`cartesia.ts`) owns the event framing. Keep that boundary.
- **Tests use a fake `AgentPort`** (see `test/session.test.ts`), so the suite runs without a Cartesia account - including the ack ordering gate and the goodbye paths.
- **Docs live in `website/`** (this site). Any merged change to `website/` redeploys the site automatically.

## Documentation policy

Document how to **connect to** the hosted StandIn service and how the bridge behaves on the wire. Do not document the internals of the hosted media bridge - this repository only depends on its published wire contract.
