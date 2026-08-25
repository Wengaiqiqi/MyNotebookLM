import { describe, expect, it } from "vitest";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";

function flattenKeys(value: object, prefix = ""): string[] {
  return Object.entries(value)
    .flatMap(([key, nested]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof nested === "object" && nested !== null
        ? flattenKeys(nested, path)
        : [path];
    })
    .sort();
}

describe("locale resources", () => {
  it("keeps English and Chinese locale keys identical", () => {
    expect(flattenKeys(en)).toEqual(flattenKeys(zhCN));
  });

  it("contains every project-shell translation", () => {
    expect(flattenKeys(en)).toEqual(expect.arrayContaining([
      "app.name",
      "app.settings",
      "common.cancel",
      "common.confirm",
      "common.dark",
      "common.language",
      "common.light",
      "common.theme",
      "error.archiveProject",
      "error.createProject",
      "error.loadProjects",
      "error.removeProject",
      "error.renameProject",
      "project.archive",
      "project.create",
      "project.emptyBody",
      "project.emptyTitle",
      "project.menu",
      "project.nameLabel",
      "project.remove",
      "project.removeConfirm",
      "project.rename",
      "project.title",
      "research.ask",
      "research.importSources",
      "research.noSourcesBody",
      "research.noSourcesTitle",
      "research.researchChatUnavailable",
      "research.settingsUnavailable",
      "research.sourceImportUnavailable",
      "research.sources",
      "research.workspaceTitle"
    ]));
  });

  it("contains every sanitized model-service message key", () => {
    expect(flattenKeys(en)).toEqual(expect.arrayContaining([
      "errors.authentication",
      "errors.builtInModelImmutable",
      "errors.cancelled",
      "errors.configuration",
      "errors.credentialBinding",
      "errors.internal",
      "errors.modelCapability",
      "errors.modelNotFound",
      "errors.modelProfileNotFound",
      "errors.modelRouteInconsistent",
      "errors.network",
      "errors.provider",
      "errors.rateLimited",
      "errors.timeout",
      "errors.validation"
    ]));
  });
});
