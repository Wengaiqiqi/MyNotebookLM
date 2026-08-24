import path from "node:path";

export type AppPaths = Readonly<{
  root: string;
  database: string;
  files: string;
  logs: string;
}>;

export function getAppPaths(userDataDir: string): AppPaths {
  return {
    root: userDataDir,
    database: path.join(userDataDir, "data", "app.db"),
    files: path.join(userDataDir, "files"),
    logs: path.join(userDataDir, "logs")
  };
}
