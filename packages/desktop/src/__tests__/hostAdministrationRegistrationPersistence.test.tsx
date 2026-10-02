/* @vitest-environment jsdom */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopLocalAgentHostProvisioner,
  type LocalAgentHostOperatorPort
} from "../main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../main/operatorControl/localAgentHostRegistrationStore.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";
import { useHostAdministrationController } from "../renderer/hooks/useHostAdministrationController.js";

const bridge = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(() => () => {}),
  getOperatorLocalAgentHostStatus: vi.fn(),
  repairOperatorLocalAgentHost: vi.fn()
}));
vi.mock("../renderer/bridge", () => ({ operatorControlBridge: bridge }));
let root: string;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it("round-trips Host administration repair through the real operator service and persisted registration", async () => {
  root = await mkdtemp(join(tmpdir(), "planweave-admin-registration-"));
  const path = join(root, "registration.json");
  const store = new LocalAgentHostRegistrationStore(path);
  const registration = await store.upsert("profile", { instanceKey: "registered-instance" });
  const operator: LocalAgentHostOperatorPort = {
    enrollHandoff: async () => {
      throw new Error("repair must not enroll");
    },
    listAgents: async () => [],
    requireUsableCredential: async () => {},
    reconcileAgentExposure: vi.fn(async () => ({ agents: [], reload: "restarted" as const })),
    installBackground: vi.fn(async () => ({
      state: "running" as const,
      platform: "macos-launch-agent" as const
    })),
    backgroundStatus: async () => ({ state: "running", platform: "macos-launch-agent" })
  };
  const provisioner = new DesktopLocalAgentHostProvisioner({
    platform: "darwin",
    launcher: { executablePath: "/test/host" },
    registrations: store,
    operator
  });
  const service = new OperatorControlService({
    profileStore: new OperatorProfileStore({ profilesPath: join(root, "profiles.json") }),
    vault: new OperatorCredentialVault({
      paths: { credentialsPath: join(root, "vault.json") },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error("unused");
        },
        decryptString: () => {
          throw new Error("unused");
        }
      }
    }),
    localAgentHost: provisioner
  });
  bridge.getOperatorControlStatus.mockImplementation(() => service.getStatus());
  bridge.getOperatorLocalAgentHostStatus.mockImplementation((input) =>
    service.getLocalAgentHostStatus(input)
  );
  bridge.repairOperatorLocalAgentHost.mockImplementation((input) =>
    service.repairLocalAgentHost(input)
  );
  const hook = renderHook(() => useHostAdministrationController());
  await waitFor(() => expect(hook.result.current.localAgentHost?.state).toBe("ready"));
  await act(async () => {
    await hook.result.current.repairLocalAgentHost(["codex-acp"]);
  });
  expect(operator.reconcileAgentExposure).toHaveBeenCalledWith(
    expect.stringContaining("registered-instance"),
    ["codex-acp"]
  );
  expect(operator.installBackground).toHaveBeenCalledOnce();
  expect(hook.result.current.localAgentHost).toMatchObject({ state: "ready" });
  expect(hook.result.current.localAgentHost).not.toHaveProperty("generation");
  expect(await new LocalAgentHostRegistrationStore(path).get("profile")).toEqual(registration);
});
