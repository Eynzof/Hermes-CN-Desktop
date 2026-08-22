import type {
  GoogleOAuthTokenState,
  MeetJoinInput,
  MeetJoinResult,
  MeetLeaveInput,
  MeetLeaveResult,
  MeetSayInput,
  MeetSayResult,
  MeetSetupResult,
  MeetStatusInput,
  MeetStatusResult,
  MeetTranscriptInput,
  MeetTranscriptResult,
} from "@hermes/protocol";
import type { ToolResult } from "../types.js";
import { isSafeMeetUrl, meetingIdFromUrl, parseDurationMinutes } from "./url-gate.js";
import { botStatusSummary, parseTranscript, transcriptTail } from "./artifacts.js";
import type { MeetToolContext } from "./types.js";

function compactJson(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

function toolError(message: string): ToolResult {
  return { content: message, isError: true };
}

function toolSuccess(value: unknown): ToolResult {
  return { content: compactJson(value) };
}

async function invoke<T>(ctx: MeetToolContext, command: string, args: Record<string, unknown>): Promise<T> {
  if (!ctx.invoke) throw new Error(`Meet tool "${command}" requires the desktop Rust runtime.`);
  return (await ctx.invoke(command, args)) as T;
}

async function readGoogleOAuthState(ctx: MeetToolContext): Promise<GoogleOAuthTokenState | undefined> {
  if (ctx.googleOAuth?.getState) {
    const state = await ctx.googleOAuth.getState();
    if (state) return state;
  }
  if (ctx.invoke) {
    const result = (await ctx.invoke("meet_oauth_read", {})) as { ok: boolean; provider?: GoogleOAuthTokenState; error?: string };
    if (result.ok && result.provider) return result.provider;
  }
  return undefined;
}

export async function meetJoin(args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  const a = args as MeetJoinInput;
  const url = a.url?.trim();
  if (!url) return toolError("url is required");
  if (!isSafeMeetUrl(url)) return toolError(`Invalid or unsafe Meet URL: ${url}`);

  const meetingId = meetingIdFromUrl(url);
  if (!meetingId) return toolError(`Could not extract meeting id from URL: ${url}`);

  const durationMinutes = parseDurationMinutes(a.duration_minutes);
  try {
    const result = await invoke<MeetJoinResult>(ctx, "meet_join", {
      url,
      meetingId,
      guestName: a.guest_name ?? "Hermes Agent",
      durationMinutes,
      mode: a.mode ?? "transcribe",
      headed: a.headed ?? false,
    });
    if (!result.success) return toolError(result.error ?? "Failed to join meeting");
    return toolSuccess({ success: true, meeting_id: result.meeting_id, out_dir: result.out_dir });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function meetStatus(args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  const a = args as MeetStatusInput;
  try {
    const result = await invoke<MeetStatusResult>(ctx, "meet_status", {
      meetingId: a.meeting_id,
    });
    if (!result.success) return toolError(result.error ?? "Failed to get meeting status");
    return toolSuccess({
      success: true,
      active: result.active,
      summary: botStatusSummary(result.status),
      status: result.status,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function meetTranscript(args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  const a = args as MeetTranscriptInput;
  try {
    const result = await invoke<MeetTranscriptResult>(ctx, "meet_transcript", {
      meetingId: a.meeting_id,
      last: a.last,
    });
    if (!result.success) return toolError(result.error ?? "Failed to read transcript");
    return toolSuccess({
      success: true,
      lines: result.lines,
      line_count: result.lines?.length ?? 0,
    });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function meetLeave(args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  const a = args as MeetLeaveInput;
  try {
    const result = await invoke<MeetLeaveResult>(ctx, "meet_leave", {
      meetingId: a.meeting_id,
      reason: a.reason ?? "user request",
    });
    if (!result.success) return toolError(result.error ?? "Failed to leave meeting");
    return toolSuccess({ success: true, meeting_id: result.meeting_id });
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export async function meetSay(args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  const a = args as MeetSayInput;
  const text = a.text?.trim();
  if (!text) {
    return toolSuccess({ ok: false, reason: "text is required" } as MeetSayResult);
  }

  // v1: realtime speech is deferred. Report a clear reason.
  try {
    const result = await invoke<MeetSayResult>(ctx, "meet_say", {
      meetingId: a.meeting_id,
      text,
    });
    return toolSuccess(result);
  } catch {
    return toolSuccess({ ok: false, reason: "meet_say is not available in transcribe mode" } as MeetSayResult);
  }
}

export async function meetSetup(_args: unknown, ctx: MeetToolContext): Promise<ToolResult> {
  try {
    const result = await invoke<MeetSetupResult>(ctx, "meet_setup", {});
    return toolSuccess(result);
  } catch (err) {
    return toolError(err instanceof Error ? err.message : String(err));
  }
}

export { readGoogleOAuthState };
