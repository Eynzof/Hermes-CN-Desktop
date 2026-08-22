/**
 * Google Meet REST API client for post-meeting artifacts.
 *
 * Live transcription is NOT available via the Meet API; this client fetches
 * conferenceRecords, participants, recordings, and transcripts after the meeting
 * ends. Requires a Google Workspace account and restricted OAuth scopes.
 */

import type {
  GoogleOAuthTokenState,
  MeetConferenceRecord,
  MeetListConferenceRecordsResponse,
  MeetListRecordingsResponse,
  MeetListTranscriptsResponse,
} from "@hermes/protocol";

export const MEET_API_BASE = "https://meet.googleapis.com/v1";

export interface MeetClientOptions {
  tokenState: GoogleOAuthTokenState;
  refreshToken: () => Promise<GoogleOAuthTokenState>;
}

export class MeetApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "MeetApiError";
  }
}

export class MeetRestClient {
  private token: GoogleOAuthTokenState;
  private refresh: () => Promise<GoogleOAuthTokenState>;

  constructor(opts: MeetClientOptions) {
    this.token = opts.tokenState;
    this.refresh = opts.refreshToken;
  }

  private async ensureToken(): Promise<string> {
    const expiresAt = new Date(this.token.expires_at).getTime();
    if (Date.now() >= expiresAt - 60_000) {
      this.token = await this.refresh();
    }
    return this.token.access_token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.ensureToken();
    const url = `${MEET_API_BASE}${path}`;
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const data = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      throw new MeetApiError(
        `Meet API error: ${response.status} ${response.statusText}`,
        response.status,
        data,
      );
    }
    return data;
  }

  async listConferenceRecords(opts?: { pageToken?: string; pageSize?: number }): Promise<MeetListConferenceRecordsResponse> {
    const params = new URLSearchParams();
    if (opts?.pageToken) params.set("pageToken", opts.pageToken);
    if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
    const query = params.toString();
    return this.request<MeetListConferenceRecordsResponse>(`/conferenceRecords${query ? `?${query}` : ""}`);
  }

  async getConferenceRecord(name: string): Promise<MeetConferenceRecord> {
    return this.request<MeetConferenceRecord>(`/${name.startsWith("conferenceRecords/") ? name : `conferenceRecords/${name}`}`);
  }

  async listParticipants(conferenceRecordName: string, opts?: { pageToken?: string; pageSize?: number }): Promise<{
    participants?: { name: string; signedinUser?: { displayName?: string }; anonymousUser?: string }[];
    nextPageToken?: string;
  }> {
    const record = conferenceRecordName.startsWith("conferenceRecords/")
      ? conferenceRecordName
      : `conferenceRecords/${conferenceRecordName}`;
    const params = new URLSearchParams();
    if (opts?.pageToken) params.set("pageToken", opts.pageToken);
    if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
    const query = params.toString();
    return this.request(`/${record}/participants${query ? `?${query}` : ""}`);
  }

  async listRecordings(conferenceRecordName: string, opts?: { pageToken?: string; pageSize?: number }): Promise<MeetListRecordingsResponse> {
    const record = conferenceRecordName.startsWith("conferenceRecords/")
      ? conferenceRecordName
      : `conferenceRecords/${conferenceRecordName}`;
    const params = new URLSearchParams();
    if (opts?.pageToken) params.set("pageToken", opts.pageToken);
    if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
    const query = params.toString();
    return this.request<MeetListRecordingsResponse>(`/${record}/recordings${query ? `?${query}` : ""}`);
  }

  async listTranscripts(conferenceRecordName: string, opts?: { pageToken?: string; pageSize?: number }): Promise<MeetListTranscriptsResponse> {
    const record = conferenceRecordName.startsWith("conferenceRecords/")
      ? conferenceRecordName
      : `conferenceRecords/${conferenceRecordName}`;
    const params = new URLSearchParams();
    if (opts?.pageToken) params.set("pageToken", opts.pageToken);
    if (opts?.pageSize) params.set("pageSize", String(opts.pageSize));
    const query = params.toString();
    return this.request<MeetListTranscriptsResponse>(`/${record}/transcripts${query ? `?${query}` : ""}`);
  }
}

export function makeMeetClient(
  tokenState: GoogleOAuthTokenState,
  refresh: () => Promise<GoogleOAuthTokenState>,
): MeetRestClient {
  return new MeetRestClient({ tokenState, refreshToken: refresh });
}
