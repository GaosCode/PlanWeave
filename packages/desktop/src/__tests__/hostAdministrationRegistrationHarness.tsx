/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { OperatorControlStatus, OperatorProfileView } from "../shared/operatorControl";
import { useHostAdministrationController } from "../renderer/hooks/useHostAdministrationController";

import { createTranslator } from "../renderer/i18n";

const bridgeMock = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(),
  listOperatorHosts: vi.fn(),
  getOperatorLocalAgentHostStatus: vi.fn(),
  copyOperatorHostBootstrapHandoff: vi.fn(),
  registerOperatorLocalAgentHost: vi.fn(),
  enrollOperatorLocalAgentHost: vi.fn(),
  revokeOperatorHost: vi.fn(),
  renewOperatorHostCredential: vi.fn(),
  repairOperatorLocalAgentHost: vi.fn()
}));

export { bridgeMock };

vi.mock("../renderer/bridge", () => ({
  collaborationBridge: null,
  operatorControlBridge: bridgeMock
}));

vi.mock("../renderer/hooks/useCollaborationStatus", () => ({
  useCollaborationStatus: () => ({
    status: {
      activeProfileId: "collab-1",
      profiles: [
        {
          profileId: "collab-1",
          humanPrincipalId: "workspace-human-other",
          serverBaseUrl: "https://server.example/"
        }
      ],
      session: { phase: "connected" }
    },
    loading: false,
    error: null,
    refresh: async () => undefined
  })
}));

export function profile(
  profileId: string,
  overrides: Partial<OperatorProfileView> = {}
): OperatorProfileView {
  return {
    profileId,
    displayName: `Profile ${profileId}`,
    serverBaseUrl: "https://server.example/",
    allowInsecureTransport: false,
    hostedByThisDesktop: false,
    endpoint: {
      topology: "public_https" as const,
      serverOrigin: "https://server.example",
      allowedClientOrigins: ["https://server.example"],
      tlsTrust: "system_ca" as const
    },
    operatorId: `operator-${profileId}`,
    humanPrincipalId: "owner-human-1",
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only" as const,
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    ...overrides
  };
}

export function status(
  activeProfileId = "profile-a",
  activeProfile = profile(activeProfileId)
): OperatorControlStatus {
  return {
    profiles: [activeProfile],
    activeProfileId,
    credentialStorage: "available" as const,
    nonPersistenceWarning: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only" as const,
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

export function host(id: string) {
  return {
    id,
    displayName: id,
    capabilities: [],
    capacity: 1,
    online: false,
    availability: { status: "unavailable" as const, reason: "offline" as const }
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

export let statusListener: ((next: ReturnType<typeof status>) => void) | undefined;

beforeEach(() => {
  statusListener = undefined;
  bridgeMock.getOperatorControlStatus.mockResolvedValue(status());
  bridgeMock.onOperatorControlStatusChanged.mockImplementation((listener) => {
    statusListener = listener;
    return () => undefined;
  });
  bridgeMock.listOperatorHosts.mockResolvedValue({ items: [host("host-a")], nextCursor: null });
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({
    supported: true,
    state: "not_registered",
    agents: []
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.values(bridgeMock).forEach((mock) => {
    mock.mockReset();
  });
});

import { HostAdministrationContent } from "../renderer/settings/HostAdministrationSection";
export let controller: ReturnType<typeof useHostAdministrationController>;
function Harness({ setupOnly }: { setupOnly: boolean }) {
  controller = useHostAdministrationController();
  return (
    <HostAdministrationContent
      controller={controller}
      t={createTranslator("zh-CN")}
      setupOnly={setupOnly}
      showDeploymentConnection={false}
    />
  );
}
export function inventory(exposed = false) {
  return {
    supported: true,
    state: exposed ? ("ready" as const) : ("not_registered" as const),
    agents: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: false,
        exposed,
        ready: false
      }
    ]
  };
}
export async function ready(withAdministrativeProfile = true, setupOnly = true) {
  if (!withAdministrativeProfile) {
    bridgeMock.getOperatorControlStatus.mockResolvedValue({
      ...status(),
      profiles: [],
      activeProfileId: null
    });
  }
  bridgeMock.getOperatorLocalAgentHostStatus.mockImplementation(async () => inventory());
  await act(async () => {
    render(<Harness setupOnly={setupOnly} />);
  });
  expect(screen.getByTestId("host-admin-local-agent-codex-acp")).toBeTruthy();
  expect(controller.hostInventoryState).toBe(
    withAdministrativeProfile ? "ready" : "profile_missing"
  );
}
export function checked() {
  return (screen.getByTestId("host-admin-local-agent-codex-acp") as HTMLInputElement).checked;
}
export function disabled(id: string) {
  return (screen.getByTestId(id) as HTMLButtonElement).disabled;
}
