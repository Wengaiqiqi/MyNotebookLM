import React from "react";
import type { SourceDto } from "../../../shared/sources";

export default function SourceKindIcon({ kind, className = "" }: { kind: SourceDto["kind"]; className?: string }) {
  const shapeClass = `source-kind-icon source-kind-icon-${kind} ${className} ${className ? `${className}-${kind}` : ""}`.trim();
  if (kind === "url") return <span className={shapeClass} aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.2 2.2 3.2 4.8 3.2 8s-1 5.8-3.2 8c-2.2-2.2-3.2-4.8-3.2-8S9.8 6.2 12 4Z" /></svg></span>;
  if (kind === "pdf") return <span className={shapeClass} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4" /><text x="7" y="17">PDF</text></svg></span>;
  return <span className={shapeClass} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h4M9 12h6M9 16h6" /></svg></span>;
}
