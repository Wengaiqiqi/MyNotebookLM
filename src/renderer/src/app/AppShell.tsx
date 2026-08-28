import type { ReactNode } from "react";
import React from "react";

export default function AppShell({ children, dialogOpen = false }: { children: ReactNode; dialogOpen?: boolean }) {
  return <div className="app-shell" inert={dialogOpen ? true : undefined} aria-hidden={dialogOpen ? true : undefined}>{children}</div>;
}
