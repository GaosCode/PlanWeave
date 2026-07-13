import { join } from "node:path";
import type { Server } from "node:http";
import { networkInterfaces } from "node:os";
import { startPlanweaveServer, type PlanweaveServer } from "@planweave-ai/server";
import { desktopHomePaths } from "./planweaveHomePaths.js";
import { createRemoteProfile } from "./remoteProfiles.js";
import type { LocalTeamHost } from "../shared/remoteTypes.js";

let running: { app: PlanweaveServer; http: Server; port: number; networkScope: "local" | "lan"; joinToken: string; inviteUrl: string; repositoryPath?: string; targetBranch: string } | null = null;

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("No active IPv4 LAN interface was found");
}

export async function startLocalTeamHost(input: {
  projectId: string;
  projectName: string;
  userId: string;
  deviceId: string;
  joinToken: string;
  port?: number;
  allowInsecureLan?: boolean;
  repositoryPath?: string;
  targetBranch?: string;
}): Promise<LocalTeamHost> {
  const port = input.port ?? 8788;
  const networkScope = input.allowInsecureLan ? "lan" : "local";
  const bindHost = networkScope === "lan" ? "0.0.0.0" : "127.0.0.1";
  const repositoryPath = input.repositoryPath?.trim() || undefined;
  const targetBranch = input.targetBranch?.trim() || "main";
  if (input.joinToken.trim().length < 24) throw new Error("Team join token must contain at least 24 characters");
  if (running && (running.port !== port || running.networkScope !== networkScope || running.joinToken !== input.joinToken || running.repositoryPath !== repositoryPath || running.targetBranch !== targetBranch)) {
    throw new Error("A local team server is already running with different network settings or credentials");
  }
  if (!running) {
    const inviteHost = networkScope === "lan" ? lanAddress() : "127.0.0.1";
    const dataDirectory = join(desktopHomePaths().planweaveHome, "desktop", "team-server");
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "planweave-server.sqlite"), host: bindHost, port, busyTimeoutMs: 5000, joinToken: input.joinToken, ...(repositoryPath ? { repositoryPath } : {}), targetBranch, repositoryChecks: ["pnpm-lint", "pnpm-build", "pnpm-test"], requireMergeApproval: true });
    const http = app.createHttpServer();
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, bindHost, resolve);
      });
    } catch (error) {
      http.close();
      app.close();
      throw error;
    }
    running = { app, http, port, networkScope, joinToken: input.joinToken, inviteUrl: `http://${inviteHost}:${port}`, ...(repositoryPath ? { repositoryPath } : {}), targetBranch };
  }
  const localUrl = `http://127.0.0.1:${running.port}`;
  const profile = await createRemoteProfile({
    name: `${input.projectName} (host)`,
    serverUrl: localUrl,
    deviceId: input.deviceId,
    apiKey: input.joinToken,
    projectId: input.projectId,
    userId: input.userId
  });
  return { profile, localUrl, inviteUrl: running.inviteUrl, port: running.port, networkScope: running.networkScope };
}

export async function stopLocalTeamHost(): Promise<void> {
  if (!running) return;
  const { app, http } = running;
  running = null;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  app.close();
}
