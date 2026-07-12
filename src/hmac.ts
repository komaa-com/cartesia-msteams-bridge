import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The HMAC scheme the StandIn media bridge signs upgrades with:
 * signature = HMAC-SHA256(secret, "{timestampMs}.{callId}") hex-lowercased.
 * The worker sends it on the WS upgrade in X-OpenClawTeamsBridge-Timestamp /
 * X-OpenClawTeamsBridge-Signature; the bridge replays the computation.
 */
export function sign(secret: string, timestampMs: number | string, callId: string): string {
  return createHmac("sha256", secret).update(`${timestampMs}.${callId}`, "utf8").digest("hex");
}

/** Constant-time verification; false on any missing input rather than throwing. */
export function verify(
  secret: string,
  timestampMs: number | string,
  callId: string,
  signature: string,
): boolean {
  if (!secret || !callId || !signature) {
    return false;
  }
  const expected = Buffer.from(sign(secret, timestampMs, callId), "utf8");
  const provided = Buffer.from(signature.toLowerCase(), "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Timestamp freshness check (worker documents a ±60s replay window). */
export function isFresh(timestampMs: number, windowMs: number, nowMs = Date.now()): boolean {
  return Number.isFinite(timestampMs) && Math.abs(nowMs - timestampMs) <= windowMs;
}

export const TIMESTAMP_HEADER = "x-standin-timestamp";
export const SIGNATURE_HEADER = "x-standin-signature";
/** Legacy header names (pre-rename). Still accepted during the transition; the
 *  StandIn media bridge sends BOTH pairs, so either version interoperates. */
export const LEGACY_TIMESTAMP_HEADER = "x-openclawteamsbridge-timestamp";
export const LEGACY_SIGNATURE_HEADER = "x-openclawteamsbridge-signature";
