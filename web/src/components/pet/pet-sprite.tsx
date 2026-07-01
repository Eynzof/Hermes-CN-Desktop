import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { PetInfo, PetState } from "@/lib/pet";

const STATE_ROW: Record<PetState, string[]> = {
  idle: ["idle"],
  wave: ["waving", "wave"],
  run: ["running", "running-right", "run"],
  failed: ["failed", "sad"],
  review: ["review", "thinking", "idle"],
  jump: ["jumping", "jump"],
  waiting: ["waiting", "idle"],
};

function rowIndex(info: PetInfo, state: PetState): number {
  const rows = info.stateRows ?? [];
  const wanted = STATE_ROW[state] ?? ["idle"];
  const index = rows.findIndex((row) => wanted.includes(row));
  if (index >= 0) return index;
  const fallback = ["idle", "waving", "running", "failed", "review", "jumping", "waiting"];
  return Math.max(0, fallback.findIndex((row) => wanted.includes(row)));
}

function frameCount(info: PetInfo, state: PetState, row: number): number {
  const rows = info.stateRows ?? [];
  const rowName = rows[row];
  if (rowName && info.framesByRow?.[rowName]) return Math.max(1, info.framesByRow[rowName]);
  if (info.framesByState?.[state]) return Math.max(1, info.framesByState[state]);
  return Math.max(1, info.framesPerState ?? 1);
}

export function PetSprite({ info, state, className }: { info: PetInfo; state: PetState; className?: string }) {
  const [frame, setFrame] = useState(0);
  const frameW = info.frameW ?? 192;
  const frameH = info.frameH ?? 208;
  const scale = info.scale ?? 0.33;
  const row = rowIndex(info, state);
  const count = frameCount(info, state, row);
  const src = info.spritesheetBase64 && info.mime ? `data:${info.mime};base64,${info.spritesheetBase64}` : "";

  useEffect(() => {
    setFrame(0);
  }, [state, info.spritesheetRevision]);

  useEffect(() => {
    if (!src || count <= 1) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % count), Math.max(80, (info.loopMs ?? 900) / count));
    return () => window.clearInterval(timer);
  }, [count, info.loopMs, src]);

  const style = useMemo<CSSProperties>(() => ({
    width: frameW * scale,
    height: frameH * scale,
    backgroundImage: `url(${src})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${frameW * (info.framesPerState ?? count) * scale}px auto`,
    backgroundPosition: `-${frame * frameW * scale}px -${row * frameH * scale}px`,
  }), [count, frame, frameH, frameW, info.framesPerState, row, scale, src]);

  if (!src) return null;
  return <div className={className} style={style} aria-label={info.displayName ?? "Hermes pet"} />;
}
