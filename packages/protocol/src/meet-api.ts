import { z } from "zod";

// -----------------------------------------------------------------------------
// Google Meet bundled plugin — protocol schemas.
// Mirrors the Python google_meet plugin artifact and tool JSON shapes.
// -----------------------------------------------------------------------------

export const MeetMode = z.enum(["transcribe", "realtime"]);
export type MeetMode = z.infer<typeof MeetMode>;

export const MeetActivePointer = z.object({
  pid: z.number().optional(),
  meetingId: z.string(),
  outDir: z.string(),
  url: z.string(),
  startedAt: z.string(),
  sessionId: z.string().optional(),
  logPath: z.string().optional(),
  mode: MeetMode.default("transcribe"),
}).passthrough();
export type MeetActivePointer = z.infer<typeof MeetActivePointer>;

export const MeetBotStatus = z.object({
  meetingId: z.string().optional(),
  url: z.string().optional(),
  inCall: z.boolean().optional(),
  captioning: z.boolean().optional(),
  captionsEnabledAttempted: z.boolean().optional(),
  lobbyWaiting: z.boolean().optional(),
  joinAttemptedAt: z.string().optional(),
  joinedAt: z.string().optional(),
  lastCaptionAt: z.string().optional(),
  transcriptLines: z.number().optional(),
  transcriptPath: z.string().optional(),
  error: z.string().optional(),
  exited: z.boolean().optional(),
  pid: z.number().optional(),
  leaveReason: z.string().optional(),
}).passthrough();
export type MeetBotStatus = z.infer<typeof MeetBotStatus>;

export const MeetTranscriptLine = z.object({
  ts: z.string(),
  speaker: z.string(),
  text: z.string(),
});
export type MeetTranscriptLine = z.infer<typeof MeetTranscriptLine>;

// -----------------------------------------------------------------------------
// Tool I/O
// -----------------------------------------------------------------------------

export const MeetJoinInput = z.object({
  url: z.string().describe("Google Meet URL (https://meet.google.com/...)"),
  guest_name: z.string().default("Hermes Agent").describe("Display name for the virtual participant"),
  duration_minutes: z.number().optional().describe("Auto-leave after N minutes"),
  mode: MeetMode.default("transcribe").describe("transcribe = captions only; realtime = deferred"),
  headed: z.boolean().optional().describe("Show browser window (debug)"),
});
export type MeetJoinInput = z.infer<typeof MeetJoinInput>;

export const MeetJoinResult = z.object({
  success: z.boolean(),
  meeting_id: z.string().optional(),
  out_dir: z.string().optional(),
  error: z.string().optional(),
});
export type MeetJoinResult = z.infer<typeof MeetJoinResult>;

export const MeetStatusInput = z.object({
  meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
});
export type MeetStatusInput = z.infer<typeof MeetStatusInput>;

export const MeetStatusResult = z.object({
  success: z.boolean(),
  active: z.boolean().optional(),
  status: MeetBotStatus.optional(),
  error: z.string().optional(),
});
export type MeetStatusResult = z.infer<typeof MeetStatusResult>;

export const MeetTranscriptInput = z.object({
  meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
  last: z.number().optional().describe("Return last N lines"),
});
export type MeetTranscriptInput = z.infer<typeof MeetTranscriptInput>;

export const MeetTranscriptResult = z.object({
  success: z.boolean(),
  lines: z.array(MeetTranscriptLine).optional(),
  raw: z.string().optional(),
  error: z.string().optional(),
});
export type MeetTranscriptResult = z.infer<typeof MeetTranscriptResult>;

export const MeetLeaveInput = z.object({
  meeting_id: z.string().optional().describe("Meeting id; uses active meeting if omitted"),
  reason: z.string().default("user request"),
});
export type MeetLeaveInput = z.infer<typeof MeetLeaveInput>;

export const MeetLeaveResult = z.object({
  success: z.boolean(),
  meeting_id: z.string().optional(),
  error: z.string().optional(),
});
export type MeetLeaveResult = z.infer<typeof MeetLeaveResult>;

export const MeetSayInput = z.object({
  meeting_id: z.string().optional(),
  text: z.string().describe("Text to speak in the meeting"),
});
export type MeetSayInput = z.infer<typeof MeetSayInput>;

export const MeetSayResult = z.object({
  ok: z.boolean(),
  queued: z.boolean().optional(),
  reason: z.string().optional(),
});
export type MeetSayResult = z.infer<typeof MeetSayResult>;

export const MeetSetupResult = z.object({
  ok: z.boolean(),
  chromium_available: z.boolean().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});
export type MeetSetupResult = z.infer<typeof MeetSetupResult>;

// -----------------------------------------------------------------------------
// OAuth
// -----------------------------------------------------------------------------

export const GoogleOAuthStartInput = z.object({
  clientId: z.string(),
  redirectUri: z.string().optional(),
  scope: z.string().optional(),
});
export type GoogleOAuthStartInput = z.infer<typeof GoogleOAuthStartInput>;

export const GoogleOAuthStartResult = z.object({
  authUrl: z.string(),
  codeVerifier: z.string(),
  state: z.string(),
  redirectUri: z.string(),
});
export type GoogleOAuthStartResult = z.infer<typeof GoogleOAuthStartResult>;

export const GoogleOAuthCallbackResult = z.object({
  code: z.string(),
  state: z.string(),
});
export type GoogleOAuthCallbackResult = z.infer<typeof GoogleOAuthCallbackResult>;

export const GoogleOAuthTokenInput = z.object({
  clientId: z.string(),
  code: z.string(),
  codeVerifier: z.string(),
  redirectUri: z.string(),
});
export type GoogleOAuthTokenInput = z.infer<typeof GoogleOAuthTokenInput>;

export const GoogleOAuthRefreshInput = z.object({
  clientId: z.string(),
  refreshToken: z.string(),
});
export type GoogleOAuthRefreshInput = z.infer<typeof GoogleOAuthRefreshInput>;

export const GoogleOAuthTokenState = z.object({
  client_id: z.string(),
  redirect_uri: z.string(),
  scope: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_at: z.string(),
  expires_in: z.number(),
  obtained_at: z.string(),
}).passthrough();
export type GoogleOAuthTokenState = z.infer<typeof GoogleOAuthTokenState>;

export const GoogleOAuthTokenResponse = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
}).passthrough();
export type GoogleOAuthTokenResponse = z.infer<typeof GoogleOAuthTokenResponse>;

export const GoogleMeetAuthJsonResult = z.object({
  ok: z.boolean(),
  provider: GoogleOAuthTokenState.optional(),
  error: z.string().optional(),
});
export type GoogleMeetAuthJsonResult = z.infer<typeof GoogleMeetAuthJsonResult>;

// -----------------------------------------------------------------------------
// Meet REST API (post-meeting artifacts)
// -----------------------------------------------------------------------------

export const MeetConferenceRecord = z.object({
  name: z.string(),
  createTime: z.string().optional(),
  destroyTime: z.string().optional(),
  space: z.string().optional(),
  expireTime: z.string().optional(),
}).passthrough();
export type MeetConferenceRecord = z.infer<typeof MeetConferenceRecord>;

export const MeetParticipant = z.object({
  name: z.string(),
  signedinUser: z.object({ displayName: z.string().optional() }).passthrough().optional(),
  anonymousUser: z.string().optional(),
}).passthrough();
export type MeetParticipant = z.infer<typeof MeetParticipant>;

export const MeetRecording = z.object({
  name: z.string(),
  driveDestination: z.object({ file: z.string().optional() }).passthrough().optional(),
  state: z.string().optional(),
}).passthrough();
export type MeetRecording = z.infer<typeof MeetRecording>;

export const MeetTranscriptEntry = z.object({
  name: z.string(),
  state: z.string().optional(),
  document: z.string().optional(),
}).passthrough();
export type MeetTranscriptEntry = z.infer<typeof MeetTranscriptEntry>;

export const MeetListConferenceRecordsResponse = z.object({
  conferenceRecords: z.array(MeetConferenceRecord).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();
export type MeetListConferenceRecordsResponse = z.infer<typeof MeetListConferenceRecordsResponse>;

export const MeetListRecordingsResponse = z.object({
  recordings: z.array(MeetRecording).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();
export type MeetListRecordingsResponse = z.infer<typeof MeetListRecordingsResponse>;

export const MeetListTranscriptsResponse = z.object({
  transcripts: z.array(MeetTranscriptEntry).optional(),
  nextPageToken: z.string().optional(),
}).passthrough();
export type MeetListTranscriptsResponse = z.infer<typeof MeetListTranscriptsResponse>;
