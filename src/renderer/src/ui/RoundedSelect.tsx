import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

export default function RoundedSelect({ value, options, ariaLabel, onChange, className = "", disabled = false }: {
  value: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (root) {
      const rect = root.getBoundingClientRect();
      setPlacement(window.innerHeight - rect.bottom < 280 && rect.top > 280 ? "up" : "down");
    }
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div className={`rounded-select ${className}${disabled ? " is-disabled" : ""}`.trim()} ref={rootRef} onKeyDown={(event) => {
      if (open && event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>(".rounded-select-trigger")?.focus();
      }
    }}>
      <button
        type="button"
        className="select rounded-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{selected?.label}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && !disabled && (
        <div className="rounded-select-menu" data-placement={placement} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="rounded-select-option"
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
