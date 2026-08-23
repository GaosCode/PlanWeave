import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exampleSetupCodeIssueResponse } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { parseCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import { serializeAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import {
  registerOperatorControlHandlers,
  resolveDesktopAgentHostLauncher,
  shutdownOperatorControlService
} from "../main/operatorControl/operatorControlHandlers.js";
import { operatorControlInvokeChannels } from "../shared/operatorControl.js";

type IpcHandler = (event: unknown, input: unknown) => unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler))
    },
    readText: vi.fn(),
    writeText: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { readText: electronMock.readText, writeText: electronMock.writeText },
  ipcMain: electronMock.ipcMain,
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage_unavailable");
    },
    decryptString: () => {
      throw new Error("safeStorage_unavailable");
    }
  }
}));

const roots: string[] = [];

describe("operator control Agent Host launcher", () => {
  it("resolves the development Electron main entry to an absolute path", () => {
    expect(
      resolveDesktopAgentHostLauncher({
        executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
        isPackaged: false,
        mainModulePath: "dist/main/main.js",
        workingDirectory: "/Users/test/PlanWeave/packages/desktop"
      })
    ).toEqual({
      executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
      fixedArgs: [
        "/Users/test/PlanWeave/packages/desktop/dist/main/main.js",
        "--agent-host-service"
      ]
    });
  });
});

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.readText.mockReset();
  electronMock.writeText.mockReset();
});

afterEach(async () => {
  await shutdownOperatorControlService();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator control main-process credential import", () => {
  it("reads the token in main and rejects renderer token smuggling", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-operator-handler-"));
    roots.push(root);
    const token = "operator_handler_token_abcdefghijklmnopqrstuvwxyz";
    const readOperatorToken = vi.fn(() => token);
    const service = registerOperatorControlHandlers({
      profileStorePaths: { profilesPath: join(root, "profiles.json") },
      credentialsPath: join(root, "credentials.json"),
      readOperatorToken
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "Operator A",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    });

    const handler = electronMock.handlers.get(operatorControlInvokeChannels.importCredential);
    if (!handler) throw new Error("operator_import_handler_missing");
    await handler({}, { profileId: "profile-a" });

    expect(readOperatorToken).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({
      profiles: [{ profileId: "profile-a", hasOperatorCredential: true }]
    });

    expect(() => handler({}, { profileId: "profile-a", operatorToken: token })).toThrow(
      "Operator IPC rejected importOperatorCredential"
    );
    expect(readOperatorToken).toHaveBeenCalledTimes(1);
  });
});

describe("operator control main-owned Host handoff", () => {
  it("rejects renderer-supplied enrollment codes before any clipboard write", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-operator-handoff-handler-"));
    roots.push(root);
    const service = registerOperatorControlHandlers({
      profileStorePaths: { profilesPath: join(root, "profiles.json") },
      credentialsPath: join(root, "credentials.json")
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "Operator A",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    });

    const handler = electronMock.handlers.get(
      operatorControlInvokeChannels.copyHostBootstrapHandoff
    );
    expect(electronMock.handlers.has(operatorControlInvokeChannels.renewHostCredential)).toBe(true);
    if (!handler) throw new Error("operator_handoff_handler_missing");
    await expect(
      handler({}, { profileId: "profile-a", enrollmentCode: `pw_enroll_${"A".repeat(43)}` })
    ).rejects.toThrow("Operator IPC rejected copyHostBootstrapHandoff");
    expect(electronMock.writeText).not.toHaveBeenCalled();
  });

  it("accepts an explicitly supplied Host handoff without reading the clipboard", async () => {
    const encodedHandoff = serializeAgentHostSetupHandoff({
      version: "agent-host-setup/v2",
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      workspaceId: "workspace-handler",
      enrollmentCode: `pw_enroll_${"D".repeat(43)}`,
      expiresAt: "2030-01-01T00:15:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      display: { workspaceName: "Workspace", serverName: "Server" }
    });
    const register = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-handler",
      background: "running",
      agents: []
    });
    registerOperatorControlHandlers({
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        repair: vi.fn(),
        register
      }
    });
    const handler = electronMock.handlers.get(operatorControlInvokeChannels.enrollLocalAgentHost);
    if (!handler) throw new Error("operator_local_host_enrollment_handler_missing");

    const result = await handler(
      {},
      {
        handoff: `planweave agent-host enroll ${encodedHandoff}`,
        exposedProfileIds: ["codex-acp"]
      }
    );

    expect(electronMock.readText).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(undefined, encodedHandoff, ["codex-acp"]);
    expect(JSON.stringify(result)).not.toContain(encodedHandoff);
    await expect(
      handler({}, { handoff: encodedHandoff, exposedProfileIds: ["codex-acp"], endpoint: {} })
    ).rejects.toThrow("Operator IPC rejected enrollLocalAgentHost");
    expect(electronMock.readText).not.toHaveBeenCalled();
  });
});

describe("operator control main-owned member setup code", () => {
  it("copies the one-time code in main and returns only redacted metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-operator-member-setup-handler-"));
    roots.push(root);
    const service = registerOperatorControlHandlers({
      profileStorePaths: { profilesPath: join(root, "profiles.json") },
      credentialsPath: join(root, "credentials.json"),
      request: vi.fn(
        async () => new Response(JSON.stringify(exampleSetupCodeIssueResponse), { status: 201 })
      )
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "Operator A",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    });
    await service.importCredential({
      profileId: "profile-a",
      operatorToken: "operator_handler_token_abcdefghijklmnopqrstuvwxyz"
    });
    const handler = electronMock.handlers.get(operatorControlInvokeChannels.copyMemberSetupCode);
    if (!handler) throw new Error("operator_member_setup_handler_missing");

    const handoff = await handler({}, { profileId: "profile-a" });

    expect(
      parseCollaborationSetupHandoffV1(electronMock.writeText.mock.calls[0]?.[0] ?? "")
    ).toEqual({
      serverBaseUrl: "https://operator.example.test/",
      setupCode: exampleSetupCodeIssueResponse.setupCode,
      allowInsecureTransport: false
    });
    expect(JSON.stringify(handoff)).not.toContain(exampleSetupCodeIssueResponse.setupCode);
    await expect(
      handler({}, { profileId: "profile-a", setupCode: exampleSetupCodeIssueResponse.setupCode })
    ).rejects.toThrow("Operator IPC rejected copyMemberSetupCode");
  });
});
