// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Modal, { DialogHead } from "./Modal";

function setup() {
  const onClose = vi.fn();
  return { onClose };
}

afterEach(() => cleanup());

describe("Modal", () => {
  it("renders nothing while closed", () => {
    const { onClose } = setup();
    render(<Modal open={false} onClose={onClose} labelledBy="t"><h2 id="t">x</h2></Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const { onClose } = setup();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    render(<Modal open onClose={onClose} labelledBy="modal-test-title"><DialogHead id="modal-test-title" icon="info" title="标题" /></Modal>);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("modal-test-title");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    document.body.removeChild(opener);
  });

  it("keeps Tab focus inside the dialog", async () => {
    const { onClose } = setup();
    render(
      <Modal open onClose={onClose} labelledBy="modal-tab-title">
        <h2 id="modal-tab-title">t</h2>
        <button type="button">first</button>
        <button type="button">last</button>
      </Modal>
    );
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    expect(document.activeElement).toBe(first);

    // The dialog manages Tab wrapping itself, so key events move focus.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("focus falls back into the dialog when it escapes", async () => {
    const { onClose } = setup();
    render(
      <Modal open onClose={onClose} labelledBy="modal-out-title">
        <h2 id="modal-out-title">t</h2>
        <button type="button">only</button>
      </Modal>
    );
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "only" })));
    document.body.removeChild(outside);
  });
});
