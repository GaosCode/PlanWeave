import { join } from "node:path";
import { LocalMcpServerManager as BaseLocalMcpServerManager } from "@planweave-ai/mcp/tunnel";

const desktopOAuthAccessTokenTtlMs = 30 * 24 * 60 * 60 * 1000;

export class LocalMcpServerManager extends BaseLocalMcpServerManager {
  constructor() {
    super({
      oauth: (planweaveHome) => ({
        enabled: true,
        accessTokenTtlMs: desktopOAuthAccessTokenTtlMs,
        clientStorePath: join(planweaveHome, "desktop", "mcp-oauth-clients.json"),
        tokenStorePath: join(planweaveHome, "desktop", "mcp-oauth-tokens.json")
      }),
      trustForwardedHeaders: true
    });
  }
}
