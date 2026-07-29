import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@hermes/shared-ui";
import {
  DEFAULT_MEMORY_CHAR_LIMIT,
  MAX_MEMORY_CHAR_LIMIT,
  useSaveMemoryCharLimit,
} from "@/hooks/use-memory";
import s from "./memory-limit-control.module.css";

export interface MemoryLimitControlProps {
  currentLimit: number;
  used: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemoryLimitControl({ currentLimit, used }: MemoryLimitControlProps) {
  const saveLimit = useSaveMemoryCharLimit();
  const [draft, setDraft] = useState(String(currentLimit));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(String(currentLimit));
  }, [currentLimit]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const limit = Number(draft);
  const invalid = !Number.isInteger(limit) || limit < 1 || limit > MAX_MEMORY_CHAR_LIMIT;
  const unchanged = limit === currentLimit;
  const helper = useMemo(() => {
    if (invalid) return `请输入 1–${MAX_MEMORY_CHAR_LIMIT.toLocaleString()} 之间的整数。`;
    if (limit < used) return "新上限低于当前内容长度；已有内容不会被截断，但需精简后才能继续写入。";
    return `默认 ${DEFAULT_MEMORY_CHAR_LIMIT.toLocaleString()} 字符，硬上限 ${MAX_MEMORY_CHAR_LIMIT.toLocaleString()} 字符。新会话会使用更新后的容量。`;
  }, [invalid, limit, used]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid || unchanged) return;
    saveLimit.mutate(limit, { onSuccess: () => setSaved(true) });
  };

  return (
    <form className={s.control} onSubmit={handleSubmit}>
      <div className={s.copy}>
        <label htmlFor="memory-char-limit">MEMORY.md 容量上限</label>
        <span>{helper}</span>
        {saveLimit.error && <span className={s.error}>{errorMessage(saveLimit.error)}</span>}
      </div>
      <div className={s.actions}>
        <div className={s.inputWrap}>
          <input
            id="memory-char-limit"
            type="number"
            min={1}
            max={MAX_MEMORY_CHAR_LIMIT}
            step={1}
            inputMode="numeric"
            value={draft}
            aria-invalid={invalid}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span>字符</span>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={invalid || unchanged || saveLimit.isPending}>
          {saveLimit.isPending ? "保存中" : saved ? "已保存" : "保存上限"}
        </Button>
      </div>
    </form>
  );
}
