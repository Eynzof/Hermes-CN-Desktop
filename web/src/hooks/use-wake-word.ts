import { useCallback, useEffect, useRef } from "react";

import { createWakeWordClientCapture } from "@/lib/wake-word/client-capture";
import {
  useWakeWordActions,
  useWakeWordState,
} from "@/lib/wake-word/wake-word-store";

/**
 * Hook that wires the wake-word detector to the renderer microphone.
 *
 * - Starts client capture when the store says `listening` is true.
 * - Listens for `wake.detected` events, stops capture, then invokes the
 *   provided `onDetected` callback (caller is responsible for starting a new
 *   session + voice turn).
 */
export function useWakeWord({
  onDetected,
}: {
  onDetected?: (event: {
    phrase: string;
    profile: string | null;
    startNewSession: boolean;
  }) => void;
}): {
  state: ReturnType<typeof useWakeWordState>;
  actions: ReturnType<typeof useWakeWordActions>;
} {
  const state = useWakeWordState();
  const actions = useWakeWordActions();
  const captureRef = useRef<ReturnType<typeof createWakeWordClientCapture> | null>(null);

  useEffect(() => {
    if (!state.listening) {
      captureRef.current?.stop();
      captureRef.current = null;
      return;
    }
    const capture = createWakeWordClientCapture((error) => {
      // eslint-disable-next-line no-console
      console.error("Wake word capture error:", error);
    });
    captureRef.current = capture;
    void capture.start();
    return () => {
      capture.stop();
    };
  }, [state.listening]);

  const handleDetected = useCallback(
    (event: { phrase: string; profile: string | null; startNewSession: boolean }) => {
      captureRef.current?.stop();
      captureRef.current = null;
      onDetected?.(event);
    },
    [onDetected],
  );

  useEffect(() => {
    const desktop = (window as unknown as { hermesDesktop?: { wakeWord?: { onDetected?: (handler: (event: { phrase: string; profile: string | null; startNewSession: boolean }) => void) => () => void } } }).hermesDesktop;
    const unlisten = desktop?.wakeWord?.onDetected?.(handleDetected);
    return () => {
      if (unlisten) unlisten();
    };
  }, [handleDetected]);

  return { state, actions };
}
