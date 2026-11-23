import { atom } from "jotai";

type StopOutcome = "finished" | "timed-out" | "failed";
interface StoppingTurn {
  waiting: boolean;
  done: Promise<StopOutcome>;
  finish: (outcome: StopOutcome) => void;
}

export const stoppingTurnsAtom = atom<Record<string, StoppingTurn>>({});
export const STOP_WAIT_MS = 10_000;

// Core acknowledges Stop before its foreground tool has unwound. Keep the
// boundary per gateway session so switching chats cannot consume another Stop.
export const beginStoppingTurnAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(stoppingTurnsAtom)[sessionId];
  if (current?.waiting) return current;
  let resolve!: (outcome: StopOutcome) => void;
  const done = new Promise<StopOutcome>(r => { resolve = r; });
  const timer = setTimeout(() => finish("timed-out"), STOP_WAIT_MS);
  function finish(outcome: StopOutcome) {
    const stops = get(stoppingTurnsAtom);
    if (stops[sessionId]?.done !== done) return;
    clearTimeout(timer);
    const next = { ...stops };
    if (outcome === "timed-out") next[sessionId] = { ...stops[sessionId], waiting: false };
    else delete next[sessionId];
    set(stoppingTurnsAtom, next);
    resolve(outcome);
  }
  const stop = { waiting: true, done, finish };
  set(stoppingTurnsAtom, { ...get(stoppingTurnsAtom), [sessionId]: stop });
  return stop;
});
