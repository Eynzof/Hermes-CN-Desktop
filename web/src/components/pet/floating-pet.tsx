import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useActiveProfileName } from "@/hooks/use-profiles";
import { chatRuntimeBySessionAtom, type ChatRuntimeBySession } from "@/stores/chat";
import { derivePetState, getPetInfo, type PetInfo, type PetState } from "@/lib/pet";
import { isSecondarySessionWindow } from "@/lib/windows";
import { PetSprite } from "./pet-sprite";
import s from "./floating-pet.module.css";

function runtimeSignals(runtimeBySession: ChatRuntimeBySession) {
  const runtimes = Object.values(runtimeBySession);
  const busy = runtimes.some((rt) => rt.streamStatus === "streaming" || rt.streamStatus === "connecting");
  const error = runtimes.some((rt) => rt.streamStatus === "error" && Date.now() - rt.updatedAt < 2500);
  const complete = runtimes.some((rt) => rt.streamStatus === "complete" && Date.now() - rt.updatedAt < 1800);
  const toolRunning = runtimes.some((rt) =>
    rt.messages.some((msg) =>
      msg.parts.some((part) => part.type === "tool" && "state" in part && part.state === "running"),
    ),
  );
  return { busy, complete, error, toolRunning };
}

export function FloatingPet() {
  const profile = useActiveProfileName();
  const runtimeBySession = useAtomValue(chatRuntimeBySessionAtom);
  const [info, setInfo] = useState<PetInfo | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const petRef = useRef<HTMLDivElement | null>(null);
  const state: PetState = derivePetState(runtimeSignals(runtimeBySession));

  useEffect(() => {
    if (isSecondarySessionWindow()) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await getPetInfo(profile);
        if (!cancelled) setInfo(next);
      } catch {
        if (!cancelled) setInfo((prev) => prev ?? { enabled: false });
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), info?.enabled ? 15000 : 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [info?.enabled, profile]);

  const payload = useMemo(() => ({ info, state }), [info, state]);
  useEffect(() => {
    if (!overlayActive) return;
    void window.hermesDesktop?.petOverlay?.pushState(payload);
  }, [overlayActive, payload]);

  useEffect(() => {
    return window.hermesDesktop?.petOverlay?.onControl((payload) => {
      if (payload && typeof payload === "object" && (payload as { type?: unknown }).type === "pop-in") {
        setOverlayActive(false);
        void window.hermesDesktop?.petOverlay?.close();
      }
    });
  }, []);

  if (isSecondarySessionWindow() || overlayActive || !info?.enabled || !info.spritesheetBase64) return null;

  const popOut = async () => {
    const rect = petRef.current?.getBoundingClientRect();
    const bounds = rect
      ? { x: rect.left, y: rect.top, width: Math.max(240, rect.width + 120), height: Math.max(300, rect.height + 180) }
      : undefined;
    const result = await window.hermesDesktop?.petOverlay?.open({ bounds });
    if (result?.ok) {
      setOverlayActive(true);
      void window.hermesDesktop?.petOverlay?.pushState(payload);
    }
  };

  return (
    <div
      ref={petRef}
      className={s.pet}
      title="Shift 点击弹出桌面悬浮宠物"
      onClick={(event) => {
        if (event.shiftKey) void popOut();
      }}
    >
      <div className={s.bubble}>{info.displayName ?? "Hermes"}</div>
      <PetSprite info={info} state={state} className={s.sprite} />
    </div>
  );
}

export function PetOverlayRoute() {
  const [payload, setPayload] = useState<{ info?: PetInfo | null; state?: PetState }>({});
  const info = payload.info;
  const state = payload.state ?? "idle";

  useEffect(() => window.hermesDesktop?.petOverlay?.onState((next) => {
    if (next && typeof next === "object") setPayload(next as { info?: PetInfo; state?: PetState });
  }), []);

  return (
    <main className={s.overlay}>
      <div className={s.overlayInner}>
        {info?.enabled && info.spritesheetBase64 ? <PetSprite info={info} state={state} className={s.sprite} /> : null}
        <button className={s.overlayBtn} type="button" onClick={() => void window.hermesDesktop?.petOverlay?.control({ type: "pop-in" })}>
          收回
        </button>
      </div>
    </main>
  );
}
