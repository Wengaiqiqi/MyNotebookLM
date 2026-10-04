import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "./database";
import { SettingsRepository } from "../settings/settings-repository";

it("upgrades map routes independently while retaining existing routes and attempt history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mynotebooklm-map-route-migration-"));
  const oldMigrations = path.join(root, "migrations");
  const migrations = path.resolve("src/main/db/migrations");
  const databasePath = path.join(root, "app.db");
  let db: AppDatabase | undefined;
  try {
    cpSync(migrations, oldMigrations, { recursive: true, filter: (source) => !/^0(2\d|[3-9]\d)_/.test(path.basename(source)) });
    expect(readdirSync(oldMigrations)).toHaveLength(19);
    db = openAppDatabase(databasePath, oldMigrations);
    const settings = new SettingsRepository(db.connection);
    const profile = { id: "11111111-1111-4111-8111-111111111111", name: "Primary", provider: "openai" as const, capability: "generation" as const, baseUrl: "https://example.test", modelId: "text-model", enabled: true };
    const fallback = { ...profile, id: "22222222-2222-4222-8222-222222222222", name: "Fallback" };
    settings.saveProfile(profile); settings.saveProfile(fallback);
    settings.replaceRoute("chat", [profile.id, fallback.id]);
    settings.replaceRoute("custom-transformation", [fallback.id]);
    db.connection.prepare("INSERT INTO projects(id,name) VALUES (?, 'Research')").run("33333333-3333-4333-8333-333333333333");
    db.connection.prepare("INSERT INTO model_route_attempts(id,project_id,operation_id,task_kind,attempt_order,profile_id,provider,model,state) VALUES (?,?,'old-map','custom-transformation',0,?,'openai','text-model','completed')").run("44444444-4444-4444-8444-444444444444", "33333333-3333-4333-8333-333333333333", fallback.id);
    db.close();
    db = openAppDatabase(databasePath, migrations);
    const upgraded = new SettingsRepository(db.connection);
    expect(upgraded.getRoute("mind-map").map((item) => item.profileId)).toEqual([profile.id, fallback.id]);
    upgraded.replaceRoute("mind-map", [fallback.id]);
    expect(upgraded.getRoute("chat").map((item) => item.profileId)).toEqual([profile.id, fallback.id]);
    expect(upgraded.getRoute("custom-transformation").map((item) => item.profileId)).toEqual([fallback.id]);
    expect(db.connection.prepare("SELECT task_kind,state FROM model_route_attempts WHERE operation_id='old-map'").get()).toEqual({ task_kind: "custom-transformation", state: "completed" });
    db.connection.prepare("INSERT INTO model_route_attempts(id,project_id,operation_id,task_kind,attempt_order,profile_id,provider,model,state) VALUES (?,?,'new-map','mind-map',0,?,'openai','text-model','completed')").run("55555555-5555-4555-8555-555555555555", "33333333-3333-4333-8333-333333333333", fallback.id);
    expect(db.connection.pragma("foreign_key_check")).toEqual([]);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});
