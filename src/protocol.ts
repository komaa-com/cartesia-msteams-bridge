/**
 * Worker wire protocol: the JSON messages the StandIn media bridge speaks (discriminated on "type").
 * JSON, camelCase properties, discriminated on "type". The worker serializes
 * with System.Text.Json camelCase options; keep field names in exact sync.
 */

export interface CallerInfo {
  /** All nullable: Graph returns partial identities for guest/anonymous callers. */
  aadId?: string | null;
  displayName?: string | null;
  tenantId?: string | null;
}

export interface SessionStartMessage {
  type: "session.start";
  callId: string;
  threadId: string;
  caller: CallerInfo;
  recordingStatus?: string | null;
  direction?: string | null;
}

export interface SessionEndMessage {
  type: "session.end";
  reason: string;
}

export interface RecordingStatusMessage {
  type: "recording.status";
  status: string;
}

export interface AudioFrameMessage {
  type: "audio.frame";
  seq: number;
  timestampMs: number;
  /** Base64 PCM16K (16 kHz, 16-bit, mono, little-endian). */
  payloadBase64: string;
  speakerName?: string | null;
}

export interface VideoFrameMessage {
  type: "video.frame";
  source: "camera" | "screenshare" | string;
  ts: number;
  width: number;
  height: number;
  mime: string;
  dataBase64: string;
  participantId?: string | null;
  participantName?: string | null;
}

export interface ParticipantsMessage {
  type: "participants";
  count: number;
}

export interface DtmfMessage {
  type: "dtmf";
  digit: string;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface AssistantSayMessage {
  type: "assistant.say";
  text: string;
}

export interface AssistantCancelMessage {
  type: "assistant.cancel";
  turnId: number;
}

export interface ExpressionMessage {
  type: "expression";
  emotion: string;
}

export interface DisplayImageMessage {
  type: "display.image";
  dataBase64: string;
  mime: string;
  durationMs?: number | null;
  mode?: string | null;
  ts?: number;
  caption?: string | null;
}

/** Messages the worker sends to the bridge. */
export type WorkerInbound =
  | SessionStartMessage
  | SessionEndMessage
  | RecordingStatusMessage
  | AudioFrameMessage
  | VideoFrameMessage
  | ParticipantsMessage
  | DtmfMessage
  | PingMessage
  | AssistantSayMessage;

/** Messages the bridge sends to the worker. */
export type WorkerOutbound =
  | AudioFrameMessage
  | AssistantCancelMessage
  | PongMessage
  | SessionEndMessage
  | ExpressionMessage
  | DisplayImageMessage;

/** Parse a worker frame; returns null on junk rather than throwing (drop + log at call site). */
export function parseWorkerMessage(raw: string | Buffer): WorkerInbound | null {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof (obj as { type?: unknown }).type !== "string") {
    return null;
  }
  return obj as WorkerInbound;
}

/** PCM16K byte length → milliseconds (16 kHz × 2 bytes = 32 bytes per ms). */
export function pcm16kBytesToMs(bytes: number): number {
  return bytes / 32;
}
