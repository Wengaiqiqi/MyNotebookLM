import path from "node:path";

export type AppPaths = Readonly<{
  root: string;
  database: string;
  files: string;
  models: string;
  logs: string;
}>;

export function getAppPaths(userDataDir: string): AppPaths {
  return {
    root: userDataDir,
    database: path.join(userDataDir, "data", "app.db"),
    files: path.join(userDataDir, "files"),
    models: path.join(userDataDir, "models", "huggingface"),
    logs: path.join(userDataDir, "logs")
  };
}
