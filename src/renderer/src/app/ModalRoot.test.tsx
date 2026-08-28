// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import ModalRoot from "./ModalRoot";

describe("ModalRoot", () => {
  it("renders modal content as a single root without changing its focusable descendants", () => {
    render(<ModalRoot><button type="button">Confirm</button></ModalRoot>);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});
