import { atom } from "jotai";

export interface ComposerDraftSignal {
  text: string;
  nonce: number;
}

/**
 * Quick-start recipe → PanelComposer prefill bridge.
 * QuickStart writes; PanelComposer listens (effect on `nonce`) and pushes the
 * text into GooseComposer via its `initial` prop. `nonce` lets the same recipe
 * re-trigger a prefill if the user edits and clicks again.
 */
export const composerPrefillAtom = atom<ComposerDraftSignal | null>(null);

/**
 * Session-scoped draft bridge.
 *
 * Some product flows need to open a brand-new session and leave a prepared
 * prompt in that session's composer without auto-submitting it. The draft is
 * intentionally renderer-local and one-shot: DetailRoute consumes it after the
 * navigation lands, so a reload or later visit will not replay stale text.
 */
export const sessionComposerDraftsAtom = atom<Record<string, ComposerDraftSignal>>({});

export function withSessionComposerDraft(
  drafts: Record<string, ComposerDraftSignal>,
  sessionId: string,
  text: string,
  nonce = Date.now(),
): Record<string, ComposerDraftSignal> {
  const cleanSessionId = sessionId.trim();
  if (!cleanSessionId) return drafts;
  return {
    ...drafts,
    [cleanSessionId]: { text, nonce },
  };
}

export function withoutSessionComposerDraft(
  drafts: Record<string, ComposerDraftSignal>,
  sessionId: string,
): Record<string, ComposerDraftSignal> {
  if (!(sessionId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[sessionId];
  return next;
}

export const setSessionComposerDraftAtom = atom(
  null,
  (_get, set, input: { sessionId: string; text: string; nonce?: number }) => {
    set(sessionComposerDraftsAtom, (drafts) =>
      withSessionComposerDraft(drafts, input.sessionId, input.text, input.nonce));
  },
);

export const consumeSessionComposerDraftAtom = atom(
  null,
  (get, set, sessionId: string): ComposerDraftSignal | null => {
    const draft = get(sessionComposerDraftsAtom)[sessionId] ?? null;
    if (draft) {
      set(sessionComposerDraftsAtom, (drafts) => withoutSessionComposerDraft(drafts, sessionId));
    }
    return draft;
  },
);
