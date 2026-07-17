import { describe, expect, it, vi } from "vitest";
import { packagedStartupSmokeEvent, runPackagedStartupSmoke } from "../main/smoke";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: vi.fn()
}));

const verifiedResult = {
  event: packagedStartupSmokeEvent,
  rendererLoaded: true,
  runtimeBridgeAvailable: true,
  isolatedProjectCount: 0,
  appUpdateBridgeAvailable: true,
  appUpdateDelivery: "in-app",
  appVersion: "0.1.1",
  metadataVerified: true
} as const;

class SmokeHtmlElement {
  childElementCount = 1;
}

interface RuntimeBridge {
  listProjects: () => Promise<unknown>;
}

interface AppUpdateBridge {
  getAppUpdateState: () => Promise<unknown>;
}

function createEvaluatingWindow(options?: {
  runtimeBridge?: RuntimeBridge | null;
  appUpdateBridge?: AppUpdateBridge | null;
}) {
  const root = new SmokeHtmlElement();
  let runtimeBridge: RuntimeBridge | null = { listProjects: async () => [] };
  if (options?.runtimeBridge !== undefined) {
    runtimeBridge = options.runtimeBridge;
  }
  let appUpdateBridge: AppUpdateBridge | null = {
    getAppUpdateState: async () => ({
      status: "idle",
      delivery: "in-app",
      currentVersion: "0.1.1",
      error: null
    })
  };
  if (options?.appUpdateBridge !== undefined) {
    appUpdateBridge = options.appUpdateBridge;
  }
  const rendererWindow = {
    planweave: runtimeBridge,
    planweaveAppUpdate: appUpdateBridge
  };
  const document = {
    readyState: "complete",
    getElementById: (id: string) => {
      if (id === "root") {
        return root;
      }
      return null;
    }
  };
  return {
    webContents: {
      executeJavaScript: (script: string): Promise<unknown> => {
        const evaluate = new Function("window", "document", "HTMLElement", `return (${script})`);
        return Promise.resolve(evaluate(rendererWindow, document, SmokeHtmlElement));
      }
    }
  };
}

describe("packaged startup smoke", () => {
  it("returns a strictly validated marker only after renderer and both bridges succeed", async () => {
    const window = createEvaluatingWindow();
    const executeJavaScript = vi.spyOn(window.webContents, "executeJavaScript");

    await expect(runPackagedStartupSmoke(window)).resolves.toEqual(verifiedResult);
    const script = executeJavaScript.mock.calls[0]?.[0] ?? "";
    expect(script).toContain('document.getElementById("root")');
    expect(script).toContain("window.planweave");
    expect(script).toContain("runtimeBridge.listProjects()");
    expect(script).toContain("window.planweaveAppUpdate");
    expect(script).toContain("appUpdateBridge.getAppUpdateState()");
  });

  it("fails closed when the runtime bridge is missing or its read call fails", async () => {
    await expect(
      runPackagedStartupSmoke(createEvaluatingWindow({ runtimeBridge: null }))
    ).rejects.toThrow("Packaged runtime bridge is unavailable.");
    await expect(
      runPackagedStartupSmoke(
        createEvaluatingWindow({
          runtimeBridge: { listProjects: async () => Promise.reject(new Error("read failed")) }
        })
      )
    ).rejects.toThrow("read failed");
  });

  it("fails closed when the app-update bridge or packaged metadata is missing", async () => {
    await expect(
      runPackagedStartupSmoke(createEvaluatingWindow({ appUpdateBridge: null }))
    ).rejects.toThrow("Packaged app-update bridge is unavailable.");
    await expect(
      runPackagedStartupSmoke(
        createEvaluatingWindow({
          appUpdateBridge: {
            getAppUpdateState: async () => ({
              status: "error",
              delivery: "github-releases",
              currentVersion: "0.1.1",
              error: "Desktop build metadata is missing."
            })
          }
        })
      )
    ).rejects.toThrow("Packaged build metadata verification failed");
  });

  it("rejects incomplete or widened readiness markers", async () => {
    const executeJavaScript = vi.fn<(script: string) => Promise<unknown>>();
    executeJavaScript.mockResolvedValue({ ...verifiedResult, metadataVerified: undefined });
    await expect(runPackagedStartupSmoke({ webContents: { executeJavaScript } })).rejects.toThrow();

    executeJavaScript.mockResolvedValue({ ...verifiedResult, unexpected: true });
    await expect(runPackagedStartupSmoke({ webContents: { executeJavaScript } })).rejects.toThrow();
  });
});
