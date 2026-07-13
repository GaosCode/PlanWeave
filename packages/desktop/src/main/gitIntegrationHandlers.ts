import { ipcMain } from "electron";
import { getStatus, listProjects } from "@planweave-ai/runtime";
import { getTokenStatus, saveAuthStore, clearAuthStore } from "@planweave-ai/mcp/github";
import { gitIntegrationInvokeChannels } from "../shared/gitIntegration.js";

export function registerGitIntegrationHandlers(): void {
  ipcMain.handle(gitIntegrationInvokeChannels.getGitStatus, async (_event, projectId: string) => {
    try {
      const projects = await listProjects();
      const project = projects.find((p) => p.projectId === projectId);
      if (!project) {
        return { status: null, error: `Project '${projectId}' not found.` };
      }
      const cwd = project.sourceRoot ?? project.rootPath;
      const status = await getStatus(cwd);
      return { status, error: null };
    } catch (error) {
      return { status: null, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(gitIntegrationInvokeChannels.getGitHubAuthStatus, async () => {
    return getTokenStatus();
  });

  ipcMain.handle(gitIntegrationInvokeChannels.gitHubLogin, async (_event, token: string) => {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "PlanWeave",
      },
    });

    if (!response.ok) {
      return { authenticated: false, login: null, scopes: [], source: null };
    }

    const user = (await response.json()) as { login: string };
    const scopesHeader = response.headers.get("X-OAuth-Scopes");
    const scopes = scopesHeader ? scopesHeader.split(",").map((s) => s.trim()) : [];

    await saveAuthStore({
      token,
      login: user.login,
      scopes,
      createdAt: new Date().toISOString(),
    });

    return { authenticated: true, login: user.login, scopes, source: "planweave_store" as const };
  });

  ipcMain.handle(gitIntegrationInvokeChannels.gitHubLogout, async () => {
    await clearAuthStore();
  });
}
