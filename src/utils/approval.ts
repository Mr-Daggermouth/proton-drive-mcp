// Human approval for a mutating call when the client advertises form elicitation.
// The only approval is an elicitation result of action "accept" with content.approve === true.
// Every other outcome fails closed. Diagnostics name the outcome; they never grant the action.

import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const MAX_APPROVAL_PROMPTS = 5;
export const APPROVAL_WINDOW_MS = 60_000;
export const DEFAULT_ELICIT_TIMEOUT_MS = 120_000;

/** Flat form schema. `default: false` is intentional: submitting the default is not approval. */
export const APPROVAL_FORM = {
  mode: "form" as const,
  requestedSchema: {
    type: "object" as const,
    properties: {
      approve: {
        type: "boolean" as const,
        title: "Approve this action",
        default: false,
      },
    },
    required: ["approve"] as ["approve"],
  },
};

export function approvalRequest(message: string) {
  return { message, ...APPROVAL_FORM };
}

export type ApprovalCode =
  | "accept"
  | "decline"
  | "cancel"
  | "timeout"
  | "unsupported"
  | "malformed"
  | "exception"
  | "throttle";

export interface ApprovalDecision {
  /** True only for an explicit accept with content.approve === true. */
  approved: boolean;
  code: ApprovalCode;
  /** Safe to show. No stacks, no raw client payloads, no filesystem paths from errors. */
  summary: string;
}

const DECLINE_SUMMARY =
  "client returned decline, which is not an approval. Nothing was changed. A host can advertise elicitation.form and still return decline immediately with no form; Cursor CLI (cursor-agent) does this when no elicitation provider is installed, and that answer is separate from Auto-review. This server applies the action only when the form returns action accept and content.approve true. A client that cannot show the form must stop advertising elicitation.form.";

const CANCEL_SUMMARY =
  "client returned cancel (the form was dismissed, not approved). Nothing was changed.";

const TIMEOUT_SUMMARY =
  "the approval form timed out before an explicit approval. Nothing was changed. In Cursor the Allow control is often inside a collapsed MCP tool row; expand that row and set approve to true. Timeout is not approval.";

const UNSUPPORTED_SUMMARY =
  "the client advertises form elicitation but rejected elicitation/create, so no approval was collected. Nothing was changed. The host must show the form or stop advertising elicitation.form. A model argument confirmed:true is not a substitute.";

const ACCEPT_FALSE_SUMMARY =
  "client returned action accept but content.approve was not true. Nothing was changed. The control defaults to false, and submitting that default is not approval. If a host Allow button submits the default instead of true, the host must return content.approve true only after the person explicitly approves the message.";

const ACCEPT_MISSING_SUMMARY =
  "client returned action accept without content.approve true. Nothing was changed. Accept alone is not approval.";

const MALFORMED_SUMMARY =
  "client response failed protocol checks and was not an explicit approval. Nothing was changed.";

export const THROTTLE_SUMMARY =
  "approval prompting is paused after 5 declined, cancelled, or timed-out forms within a minute. Nothing was changed. No further form was sent.";

function decision(code: Exclude<ApprovalCode, "accept">, summary: string): ApprovalDecision {
  return { approved: false, code, summary };
}

export function throttleDecision(): ApprovalDecision {
  return decision("throttle", THROTTLE_SUMMARY);
}

/** Decline, cancel, and timeout consume the per-minute prompt budget. Protocol failures do not, so their diagnostic stays visible. */
export function consumesPromptBudget(code: ApprovalCode): boolean {
  return code === "decline" || code === "cancel" || code === "timeout";
}

export function prunePromptTimes(times: number[], now: number): void {
  while (times.length && now - times[0] > APPROVAL_WINDOW_MS) times.shift();
}

export function approvalPromptPaused(times: number[], now: number): boolean {
  prunePromptTimes(times, now);
  return times.length >= MAX_APPROVAL_PROMPTS;
}

export function recordApprovalMiss(times: number[], now: number, code: ApprovalCode): void {
  if (consumesPromptBudget(code)) times.push(now);
}

function safeAction(value: unknown): string {
  if (typeof value !== "string") return typeof value;
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return cleaned || "unrecognized";
}

/** One line, no control characters, no absolute paths, no stack frames. */
export function sanitizeDiagnostic(message: string): string {
  const oneLine = message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  const noPaths = oneLine
    .replace(/[A-Za-z]:\\[^\s]+/g, "[path]")
    .replace(/(?:\/|\\)(?:[\w.-]+(?:\/|\\))+[\w.-]*/g, "[path]");
  const noStack = (noPaths.split(" at ")[0] ?? noPaths).trim();
  return (noStack || "unknown error").slice(0, 160);
}

export function classifyElicitationResult(res: unknown): ApprovalDecision {
  if (!res || typeof res !== "object") return decision("malformed", MALFORMED_SUMMARY);
  const action = (res as { action?: unknown }).action;
  const content = (res as { content?: unknown }).content;
  if (action === "decline") return decision("decline", DECLINE_SUMMARY);
  if (action === "cancel") return decision("cancel", CANCEL_SUMMARY);
  if (action !== "accept") {
    return decision("malformed", `client response action "${safeAction(action)}" was not accept, decline, or cancel. Nothing was changed.`);
  }
  const approve = content && typeof content === "object" ? (content as { approve?: unknown }).approve : undefined;
  if (approve === true) return { approved: true, code: "accept", summary: "explicit approval" };
  if (approve === false) return decision("malformed", ACCEPT_FALSE_SUMMARY);
  return decision("malformed", ACCEPT_MISSING_SUMMARY);
}

function errorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

export function classifyElicitationError(err: unknown): ApprovalDecision {
  const code = errorCode(err);
  const message = errorMessage(err);
  const name = err instanceof Error ? err.name : "";
  const issues = !!err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues?: unknown }).issues);
  if (name === "ZodError" || issues) return decision("malformed", MALFORMED_SUMMARY);
  if (
    code === ErrorCode.MethodNotFound ||
    /does not support form elicitation/i.test(message) ||
    /method not found/i.test(message)
  ) {
    return decision("unsupported", UNSUPPORTED_SUMMARY);
  }
  if (code === ErrorCode.InvalidParams && /schema|elicitation/i.test(message)) {
    return decision("malformed", MALFORMED_SUMMARY);
  }
  if (name === "AbortError" || (code === ErrorCode.RequestTimeout && /abort|cancelled|canceled/i.test(message) && !/timed out/i.test(message))) {
    return decision("cancel", CANCEL_SUMMARY);
  }
  if (code === ErrorCode.RequestTimeout || /timed out/i.test(message) || name === "TimeoutError") {
    return decision("timeout", TIMEOUT_SUMMARY);
  }
  const detail = sanitizeDiagnostic(code === undefined ? message : `JSON-RPC ${code}: ${stripMcpPrefix(message)}`);
  return decision("exception", `approval request failed (${detail}). Nothing was changed. The failure is not an approval.`);
}

function stripMcpPrefix(message: string): string {
  let s = message;
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^MCP error -?\d+:\s*/i, "");
  }
  return s;
}

/**
 * How long to wait for the form. The environment value can only shorten the wait
 * (or leave it at 120s). It cannot approve a call.
 */
export function elicitationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PROTON_DRIVE_ELICIT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_ELICIT_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(raw)) return DEFAULT_ELICIT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 20 || n > DEFAULT_ELICIT_TIMEOUT_MS) return DEFAULT_ELICIT_TIMEOUT_MS;
  return n;
}
