import type { ReactNode } from "react";
import React from "react";

export type AppRoute = "loading" | "onboarding" | "projects" | "settings";

export default function AppRouter({ view, loading, onboarding, settings, projects }: {
  view: AppRoute;
  loading?: ReactNode;
  onboarding?: ReactNode;
  settings?: ReactNode;
  projects: ReactNode;
}) {
  const page = view === "loading" ? loading : view === "onboarding" ? onboarding : view === "settings" ? settings : projects;
  return <div data-route={view} aria-busy={view === "loading" || undefined}>{page}</div>;
}
