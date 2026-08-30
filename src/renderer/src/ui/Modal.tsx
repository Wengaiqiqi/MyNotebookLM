import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";

function modalHost(): HTMLElement {
  let host = document.getElementById("modal-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "modal-root";
    document.body.appendChild(host);
  }
  return host;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  /** Render as an alert dialog (destructive confirmations). */
  alert?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}

/**
 * Accessible dialog: focus is trapped inside, Escape closes, and the page
 * behind is inert. Focus returns to the previously focused element on close.
 */
export default function Modal({ open, onClose, labelledBy, alert, wide, children }: ModalProps) {
  const cardRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    if (!card) return;

    const focusables = (): HTMLElement[] =>
      [...card.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
      )];
    focusables()[0]?.focus();

    const containFocus = (event: FocusEvent): void => {
      if (event.target instanceof Node && !card.contains(event.target)) {
        focusables()[0]?.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const first = focusables()[0];
      const last = focusables().at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };

    document.addEventListener("focusin", containFocus);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("focusin", containFocus);
      document.removeEventListener("keydown", onKeyDown);
      openerRef.current?.focus();
      openerRef.current = null;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="dialog-veil" role="presentation">
      <section
        ref={cardRef}
        className={`dialog${wide ? " wide" : ""}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </section>
    </div>,
    modalHost()
  );
}

export function DialogHead({ id, icon, accent, title, body }: {
  id: string;
  icon: React.ComponentProps<typeof Icon>["name"];
  accent?: boolean;
  title: string;
  body?: string;
}) {
  return (
    <div className="dialog-head">
      <span className={`dlg-glyph${accent ? " accent" : ""}`} aria-hidden="true"><Icon name={icon} /></span>
      <div>
        <h2 id={id}>{title}</h2>
        {body ? <p>{body}</p> : null}
      </div>
    </div>
  );
}
