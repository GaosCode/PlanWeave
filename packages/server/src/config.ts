import { resolve } from "node:path";

export type ServerConfig = {
  dataDirectory: string;
  databasePath: string;
  host: string;
  port: number;
  busyTimeoutMs: number;
  joinToken: string;
  repositoryPath?: string;
  targetBranch?: string;
  repositoryChecks?: string[];
  requireMergeApproval?: boolean;
};

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDirectory = resolve(env.PLANWEAVE_SERVER_DATA_DIR?.trim() || ".planweave-server");
  const port = Number(env.PLANWEAVE_SERVER_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PLANWEAVE_SERVER_PORT must be an integer between 1 and 65535.");
  const busyTimeoutMs = Number(env.PLANWEAVE_SERVER_BUSY_TIMEOUT_MS ?? 5000);
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60000) throw new Error("PLANWEAVE_SERVER_BUSY_TIMEOUT_MS must be an integer between 1 and 60000.");
  const joinToken = env.PLANWEAVE_SERVER_JOIN_TOKEN?.trim();
  if (!joinToken) throw new Error("PLANWEAVE_SERVER_JOIN_TOKEN is required");
  const repositoryPath = env.PLANWEAVE_SERVER_REPOSITORY_PATH?.trim();
  const repositoryChecks = env.PLANWEAVE_SERVER_REPOSITORY_CHECKS?.split(",").map((value) => value.trim()).filter(Boolean);
  return { dataDirectory, databasePath: resolve(dataDirectory, "planweave-server.sqlite"), host: env.PLANWEAVE_SERVER_HOST?.trim() || "127.0.0.1", port, busyTimeoutMs, joinToken, ...(repositoryPath ? { repositoryPath: resolve(repositoryPath) } : {}), targetBranch: env.PLANWEAVE_SERVER_TARGET_BRANCH?.trim() || "main", repositoryChecks: repositoryChecks?.length ? repositoryChecks : ["pnpm-lint", "pnpm-build", "pnpm-test"], requireMergeApproval: env.PLANWEAVE_SERVER_REQUIRE_MERGE_APPROVAL !== "0" };
}
