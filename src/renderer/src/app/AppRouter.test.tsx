// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import AppRouter from "./AppRouter";

describe("AppRouter", () => {
  it("renders only the page selected by the explicit view", () => {
    render(
      <AppRouter
        view="settings"
        loading={<p>loading page</p>}
        onboarding={<p>onboarding page</p>}
        settings={<p>settings page</p>}
        projects={<p>projects page</p>}
      />
    );

    expect(screen.getByText("settings page")).toBeTruthy();
    expect(screen.queryByText("projects page")).toBeNull();
    expect(screen.queryByText("loading page")).toBeNull();
  });
});
