import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional label for an action button (e.g. "撤销删除"). */
  actionLabel?: string;
  onAction?: () => void;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

function show(kind: ToastKind, message: string, options?: { actionLabel?: string; onAction?: () => void; timeoutMs?: number }): void {
  const item: ToastItem = {
    id: nextId++, kind, message,
    ...(options?.actionLabel ? { actionLabel: options.actionLabel } : {}),
    ...(options?.onAction ? { onAction: options.onAction } : {})
  };
  toasts = [...toasts, item];
  emit();
  const timeout = options?.timeoutMs ?? (options?.actionLabel ? 8000 : 4200);
  window.setTimeout(() => dismiss(item.id), timeout);
}

function dismiss(id: number): void {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export const toast = {
  info: (message: string, options?: Parameters<typeof show>[2]) => show("info", message, options),
  success: (message: string, options?: Parameters<typeof show>[2]) => show("success", message, options),
  error: (message: string, options?: Parameters<typeof show>[2]) => show("error", message, options)
};

const kindIcon: Record<ToastKind, React.ComponentProps<typeof Icon>["name"]> = {
  info: "info",
  success: "check",
  error: "alert"
};

export function ToastHost(): React.ReactNode {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const listener: Listener = (next) => setItems(next);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div className={`toast ${item.kind}`} key={item.id}>
          <Icon name={kindIcon[item.kind]} />
          <span>{item.message}</span>
          {item.actionLabel
            ? <button type="button" className="undo" onClick={() => { item.onAction?.(); dismiss(item.id); }}>{item.actionLabel}</button>
            : null}
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)}><Icon name="x" /></button>
        </div>
      ))}
    </div>,
    document.body
  );
}
