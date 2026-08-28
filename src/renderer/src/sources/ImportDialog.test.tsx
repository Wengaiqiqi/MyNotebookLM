// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportDialog from "./ImportDialog";

describe("ImportDialog", () => {
  afterEach(cleanup);
  it("uses the main-process chooser and imports its opaque tokens", async () => {
    const chooseFiles = vi.fn().mockResolvedValue(["token-1"]);
    const importFile = vi.fn().mockResolvedValue({ ok: true, value: {} });
    const onClose = vi.fn();
    render(<ImportDialog projectId="11111111-1111-4111-8111-111111111111" open chooseFiles={chooseFiles} importFile={importFile} importUrl={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /file|文件/i }));
    await waitFor(() => expect(importFile).toHaveBeenCalledWith({ projectId: "11111111-1111-4111-8111-111111111111", dialogToken: "token-1" }));
    expect(chooseFiles).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).toBeTruthy();
  });

  it("submits a URL through the main-process API", async () => {
    const importUrl = vi.fn().mockResolvedValue({ ok: true, value: {} });
    render(<ImportDialog projectId="11111111-1111-4111-8111-111111111111" open chooseFiles={vi.fn()} importFile={vi.fn()} importUrl={importUrl} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com/article" } });
    fireEvent.click(screen.getByRole("button", { name: /url|网页|导入/i }));
    await waitFor(() => expect(importUrl).toHaveBeenCalledWith({ projectId: "11111111-1111-4111-8111-111111111111", url: "https://example.com/article" }));
  });

  it("shows the authoritative unsupported-format error", async () => {
    const importFile = vi.fn().mockResolvedValue({ ok: false, error: { code: "UNSUPPORTED_FORMAT", messageKey: "errors.unsupportedFormat", recoverable: false } });
    render(<ImportDialog projectId="11111111-1111-4111-8111-111111111111" open chooseFiles={vi.fn().mockResolvedValue(["token"])} importFile={importFile} importUrl={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /file|文件/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("errors.unsupportedFormat"));
  });
});
