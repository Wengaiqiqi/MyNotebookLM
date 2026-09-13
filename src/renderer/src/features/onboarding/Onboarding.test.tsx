// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import Onboarding from "./Onboarding";
import i18n from "../../i18n";

const builtInEmbedding = {
  id: "6a6a6666-6666-4666-8666-666666666666",
  name: "Multilingual E5 Small",
  provider: "local",
  capability: "embedding",
  baseUrl: "",
  modelId: "multilingual-e5-small",
  enabled: true,
  dimension: 384,
  distance: "cosine",
  pooling: "mean",
  normalized: true,
  preprocessingVersion: "v1",
  metadata: { dimension: 384, distance: "cosine", pooling: "mean", normalized: true, preprocessingVersion: "v1" },
  editable: false,
  requiresCredential: false
} as const;

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
  (window as unknown as { myNotebook: unknown }).myNotebook = {
    models: {
      listProfiles: async () => ({ ok: true, value: { profiles: [], builtInProfiles: [builtInEmbedding], credentials: [] } }),
      getDefaultRoutes: async () => ({ ok: true, value: {} }),
      chooseLocalModel: async () => ({ ok: true, value: "C:\\models\\embedding" })
    }
  };
});

afterEach(() => cleanup());

describe("Onboarding embedding setup", () => {
  it("keeps built-in beside cloud providers and lets local mode choose a path", async () => {
    render(
      <Onboarding
        language="zh-CN"
        theme="light"
        onLanguage={() => undefined}
        onTheme={() => undefined}
        onFinish={async () => undefined}
      />
    );

    const providerGroups = await screen.findAllByRole("group", { name: "提供商" });
    const embeddingProviders = providerGroups[1]!;
    fireEvent.click(within(embeddingProviders).getByRole("button", { name: "OpenAI" }));

    expect(document.getElementById("model-baseurl-embedding")).toBeTruthy();
    expect(document.getElementById("model-key-embedding")).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "模型名称" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Gemini" })).toHaveLength(2);

    fireEvent.click(within(embeddingProviders).getByRole("button", { name: "内置模型" }));
    fireEvent.click(screen.getByRole("button", { name: "选择本机模型" }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件 / 目录" }));
    await waitFor(() => expect((document.getElementById("model-local-path-embedding") as HTMLInputElement | null)?.value).toBe("C:\\models\\embedding"));
  });
});
