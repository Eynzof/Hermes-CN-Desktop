import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Popover } from "@hermes/shared-ui";
import s from "./model-combobox.module.css";

const MAX_VISIBLE = 200;

export interface ModelComboboxProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
}

export function filterOptions(options: string[], query: string): string[] {
  if (!query) return options;
  const q = query.toLowerCase();
  return options.filter((id) => id.toLowerCase().includes(q));
}

export function ModelCombobox({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reflect external value changes while the popover is closed.
  useEffect(() => {
    if (!open) setQuery(value);
  }, [value, open]);

  // cmdk assumes its list is always visible and hard-codes aria-expanded=true.
  // This combobox places that list in a controlled Popover, so keep the DOM
  // attribute aligned with the actual popup state after each render.
  useEffect(() => {
    inputRef.current?.setAttribute("aria-expanded", open ? "true" : "false");
  }, [open, query]);

  const filtered = filterOptions(options, query);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const overflowCount = filtered.length - visible.length;
  const isFreeForm = query.length > 0 && !options.includes(query);

  const commit = (next: string) => {
    onChange(next);
    setQuery(next);
    setOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery("");
    } else {
      setQuery(value);
    }
  };

  return (
    <Command
      label={label}
      shouldFilter={false}
      loop
      className={s.root}
      onKeyDown={(event) => {
        if (composingRef.current || event.nativeEvent.isComposing) {
          // Let the IME consume Arrow / Enter during composition.
          event.stopPropagation();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          handleOpenChange(false);
          return;
        }
        if (event.key === "Enter" && isFreeForm && visible.length === 0) {
          event.preventDefault();
          commit(query);
        }
      }}
    >
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Anchor asChild>
          <Command.Input
            ref={inputRef}
            className={s.input}
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              if (!open) setOpen(true);
            }}
            onClick={() => {
              if (!open) handleOpenChange(true);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={placeholder ?? "搜索或输入模型 ID"}
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
          />
        </Popover.Anchor>
        <Popover.Portal forceMount>
          <Popover.Content
            forceMount
            className={s.panel}
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(event) => {
              // Keep focus on the input — Popover would otherwise pull it into the panel.
              event.preventDefault();
            }}
          >
            {isFreeForm && (
              <Command.Item
                value={`__custom__${query}`}
                className={s.freeFormHint}
                onSelect={() => commit(query)}
              >
                按 Enter 使用自定义 ID：<b>{query}</b>
              </Command.Item>
            )}
            <Command.List className={s.list}>
              {visible.length === 0 && !isFreeForm && (
                <Command.Empty className={s.empty}>没有匹配的模型</Command.Empty>
              )}
              {visible.map((id) => (
                <Command.Item
                  key={id}
                  value={id}
                  className={s.option}
                  onSelect={() => commit(id)}
                >
                  {id}
                </Command.Item>
              ))}
            </Command.List>
            {overflowCount > 0 && (
              <div className={s.footer}>还有 {overflowCount} 条，请继续输入过滤</div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
