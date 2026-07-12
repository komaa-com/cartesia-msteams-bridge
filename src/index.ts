/**
 * @komaa/cartesia-msteams-bridge - public API.
 *
 * Typical embedding:
 *   import { loadConfig, startServer } from "@komaa/cartesia-msteams-bridge";
 *   startServer(loadConfig());
 *
 * Or run the CLI: `npx @komaa/cartesia-msteams-bridge` (env-configured, see .env.example).
 */

export { loadConfig, type BridgeConfig } from "./config.js";
export { startServer, authorizeUpgrade, callIdFromUrl, ReplayGuard, type StartServerOptions, type BridgeServer } from "./server.js";
export { CallSession } from "./session.js";
export { renderMetrics } from "./metrics.js";
export {
  CartesiaAgentSocket,
  buildStart,
  mintAccessToken,
  synthesizeGoodbye,
  WIRE_SAMPLE_RATE,
  INPUT_FORMAT,
  type AgentPort,
  type LineConnector,
  type LineInbound,
  type LineSessionHandlers,
  type StartOptions,
  type CallerContext,
} from "./cartesia.js";
export { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, LEGACY_SIGNATURE_HEADER } from "./hmac.js";
export * from "./protocol.js";
export { logger, type Logger } from "./log.js";
