import { join } from "node:path";
import { homedir } from "node:os";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";

export type DesktopHomePaths = {
  planweaveHome: string;
  desktopSettingsFile: string;
  terminalPreferencesFile: string;
  mcpTunnelDir: string;
  mcpTunnelConfigFile: string;
  mcpTunnelDownloadsDir: string;
};

export function desktopHomePaths(): DesktopHomePaths {
  const planweaveHome = resolvePlanweaveHome();
  const desktopSettingsHome = join(homedir(), ".planweave");
  const mcpTunnelDir = join(planweaveHome, "desktop", "mcp-tunnel");
  return {
    planweaveHome,
    desktopSettingsFile: join(desktopSettingsHome, "config", "desktop-settings.json"),
    terminalPreferencesFile: join(planweaveHome, "config", "terminal-preferences.json"),
    mcpTunnelDir,
    mcpTunnelConfigFile: join(mcpTunnelDir, "config.json"),
    mcpTunnelDownloadsDir: join(mcpTunnelDir, "downloads")
  };
}
