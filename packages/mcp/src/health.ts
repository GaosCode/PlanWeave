import type { McpConfig } from "./config.js";

export type HealthPayload = {
  status: "ok";
  host: string;
  port: number;
  tokenAuthEnabled: boolean;
  planweaveHomeFromEnv: boolean;
};

export function createHealthPayload(config: McpConfig): HealthPayload {
  return {
    status: "ok",
    host: config.host,
    port: config.port,
    tokenAuthEnabled: Boolean(config.token),
    planweaveHomeFromEnv: config.planweaveHomeFromEnv
  };
}
