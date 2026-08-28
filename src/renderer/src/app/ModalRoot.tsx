import type { ReactNode } from "react";
import React from "react";
import { createPortal } from "react-dom";

export default function ModalRoot({ children }: { children?: ReactNode }) {
  if (typeof document === "undefined") return null;
  const root = document.getElementById("modal-root") ?? (() => { const node = document.createElement("div"); node.id = "modal-root"; document.body.appendChild(node); return node; })();
  return createPortal(children, root);
}
