import { atom, useAtomValue, useSetAtom } from "jotai";

import type {
  WakeStartResponse,
  WakeStatusResponse,
  WakeStopResponse,
  WakeWordState,
} from "./types";

export type { WakeWordNotice, WakeWordState } from "./types";

export const WAKE_START_TIMEOUT_MS = 180_000;

const initialState: WakeWordState = {
  available: false,
  enabled: false,
  listening: false,
  pending: false,
  phrase: "hey hermes",
  notice: null,
  lastError: null,
};

export const wakeWordAtom = atom<WakeWordState>(initialState);

export type WakeWordRequester = {
  status: () => Promise<WakeStatusResponse>;
  start: (surface: string, clientCapture: boolean, persist?: boolean) => Promise<WakeStartResponse>;
  stop: (persist?: boolean) => Promise<WakeStopResponse>;
  pause: () => Promise<{ paused: boolean; reason?: string }>;
  resume: () => Promise<{ resumed: boolean; reason?: string }>;
  feed: (pcm: string, sampleRate?: number) => Promise<{
    fed: boolean;
    reason?: string;
    detected?: { phrase: string; profile: string | null; startNewSession: boolean };
  }>;
  frameInfo: () => Promise<{ sampleRate: number; frameLength: number }>;
};

let requester: WakeWordRequester | null = null;

export function setWakeWordRequester(r: WakeWordRequester) {
  requester = r;
}

export function getWakeWordRequester(): WakeWordRequester | null {
  return requester;
}

export function applyWakeStatus(
  state: WakeWordState,
  status: WakeStatusResponse,
): WakeWordState {
  return {
    ...state,
    available: status.available,
    enabled: status.enabled,
    listening: status.listening,
    phrase: status.phrase,
    notice: status.listening ? { type: "armed" } : state.notice,
    lastError: null,
  };
}

export function applyWakeStart(
  state: WakeWordState,
  result: WakeStartResponse,
): WakeWordState {
  if (!result.started) {
    return {
      ...state,
      listening: false,
      pending: false,
      notice: { type: "refused", reason: result.reason ?? "unknown" },
      lastError: result.reason ?? null,
    };
  }
  return {
    ...state,
    listening: true,
    pending: false,
    phrase: result.phrase,
    notice: { type: "armed" },
    lastError: null,
  };
}

export function applyWakeStop(
  state: WakeWordState,
  result: WakeStopResponse,
): WakeWordState {
  return {
    ...state,
    listening: false,
    pending: false,
    notice: result.stopped ? null : { type: "error", message: result.reason ?? "stop failed" },
    lastError: result.stopped ? null : result.reason ?? null,
  };
}

export function setWakePending(state: WakeWordState, pending: boolean): WakeWordState {
  return { ...state, pending };
}

export function setWakeError(state: WakeWordState, message: string): WakeWordState {
  return {
    ...state,
    pending: false,
    lastError: message,
    notice: { type: "error", message },
  };
}

export function useWakeWordState() {
  return useAtomValue(wakeWordAtom);
}

export function useWakeWordActions() {
  const setState = useSetAtom(wakeWordAtom);

  const refreshStatus = async () => {
    const r = requester;
    if (!r) return;
    const status = await r.status();
    setState((s) => applyWakeStatus(s, status));
  };

  const armWakeWord = async (persist = false) => {
    const r = requester;
    if (!r) return;
    setState((s) => setWakePending(s, true));
    try {
      const status = await r.status();
      if (!status.available) {
        setState((s) =>
          setWakeError(s, status.hint ?? "wake word is not available on this device"),
        );
        return;
      }
      if (status.listening) {
        setState((s) => setWakePending(s, false));
        return;
      }
      const start = await r.start("gui", true, persist);
      setState((s) => applyWakeStart(s, start));
    } catch (err) {
      setState((s) => setWakeError(s, err instanceof Error ? err.message : String(err)));
    }
  };

  const disarmWakeWord = async (persist = false) => {
    const r = requester;
    if (!r) return;
    try {
      const stop = await r.stop(persist);
      setState((s) => applyWakeStop(s, stop));
    } catch (err) {
      setState((s) => setWakeError(s, err instanceof Error ? err.message : String(err)));
    }
  };

  const toggleWakeWord = async () => {
    const state = await (async () => {
      const r = requester;
      if (!r) return null;
      return r.status();
    })();
    const currentlyEnabled = state?.listening ?? false;
    if (currentlyEnabled) {
      await disarmWakeWord(true);
    } else {
      await armWakeWord(true);
    }
  };

  const resumeWakeAfterVoice = async () => {
    const r = requester;
    if (!r) return;
    try {
      await r.resume();
      const status = await r.status();
      setState((s) => applyWakeStatus(s, status));
      if (!status.listening) {
        // Re-arm if the detector did not resume (e.g. it was stopped during voice).
        await armWakeWord(false);
      }
    } catch (err) {
      setState((s) => setWakeError(s, err instanceof Error ? err.message : String(err)));
    }
  };

  return {
    refreshStatus,
    armWakeWord,
    disarmWakeWord,
    toggleWakeWord,
    resumeWakeAfterVoice,
    setNotice: (notice: WakeWordState["notice"]) => setState((s) => ({ ...s, notice })),
  };
}
