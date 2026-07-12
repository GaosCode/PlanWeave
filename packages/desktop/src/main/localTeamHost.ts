import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { startPlanweaveServer, type PlanweaveServer } from "@planweave-ai/server";
import { desktopHomePaths } from "./planweaveHomePaths.js";
import { createRemoteProfile } from "./remoteProfiles.js";
import type { LocalTeamHost } from "../shared/remoteTypes.js";

let running: { app: PlanweaveServer; http: Server; port: number } | null = null;

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

export async function startLocalTeamHost(input: {
  projectId: string;
  projectName: string;
  userId: string;
  deviceId: string;
  joinToken: string;
  port?: number;
}): Promise<LocalTeamHost> {
  const port = input.port ?? 8788;
  if (!running) {
    const dataDirectory = join(desktopHomePaths().planweaveHome, "desktop", "team-server");
    const app = await startPlanweaveServer({ dataDirectory, databasePath: join(dataDirectory, "planweave-server.sqlite"), host: "0.0.0.0", port, busyTimeoutMs: 5000, joinToken: input.joinToken });
    const http = app.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "0.0.0.0", resolve);
    });
    running = { app, http, port };
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
  return { profile, localUrl, inviteUrl: `http://${lanAddress()}:${running.port}`, port: running.port };
}

export async function stopLocalTeamHost(): Promise<void> {
  if (!running) return;
  const { app, http } = running;
  running = null;
  await new Promise<void>((resolve) => http.close(() => resolve()));
  app.close();
}
