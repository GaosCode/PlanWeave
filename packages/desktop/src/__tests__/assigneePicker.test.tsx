import { collaborationOperationScopeFixture } from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { createTranslator } from "../renderer/i18n";
import {
  buildAssigneePickerViewModel,
  type AssigneePickerViewModel
} from "../renderer/collaboration/assignmentViewModels";
import { AssigneePicker } from "../renderer/team/AssigneePicker";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";
import type { CollaborationStatus } from "../shared/collaboration";
import type { HumanMembershipView } from "@planweave-ai/collaboration-protocol/identity/workspace";

const t = createTranslator("en");

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const blockItem: WorkItemRef = { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" };

function member(
  partial: Pick<HumanMembershipView, "humanPrincipalId" | "displayName" | "role">
): HumanMembershipView {
  return {
    membershipId: `m-${partial.humanPrincipalId}`,
    projectId: "project-1",
    humanPrincipalId: partial.humanPrincipalId,
    displayName: partial.displayName,
    role: partial.role,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function connectedStatus(principalId = "human-1"): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: principalId,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      operationScope: collaborationOperationScopeFixture(),
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function taskViewModel(
  overrides: Partial<Parameters<typeof buildAssigneePickerViewModel>[0]> = {}
) {
  return buildAssigneePickerViewModel({
    workItem: taskItem,
    assignment: {
      projectId: "project-1",
      workItem: taskItem,
      target: { kind: "unassigned" },
      revision: 2,
      availability: { status: "unassigned", reason: "unassigned" }
    },
    members: [
      member({ humanPrincipalId: "human-1", displayName: "Ada Lovelace", role: "owner" }),
      member({ humanPrincipalId: "human-2", displayName: "Grace Hopper", role: "member" })
    ],
    eligible: null,
    status: connectedStatus(),
    syncPhase: "ready",
    loading: false,
    pending: false,
    staleConflict: false,
    lastError: null,
    ...overrides
  });
}

function blockViewModel() {
  return buildAssigneePickerViewModel({
    workItem: blockItem,
    assignment: {
      projectId: "project-1",
      workItem: blockItem,
      target: { kind: "unassigned" },
      revision: 0,
      availability: { status: "unassigned", reason: "unassigned" }
    },
    members: [member({ humanPrincipalId: "human-1", displayName: "Ada", role: "owner" })],
    eligible: {
      workItem: blockItem,
      humans: [
        {
          projectId: "project-1",
          humanPrincipalId: "human-1",
          membershipActive: true,
          displayName: "Ada"
        }
      ],
      hosts: [
        {
          projectId: "project-1",
          hostId: "host-1",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: true,
          capabilities: ["shell"],
          displayName: "Builder"
        },
        {
          projectId: "project-1",
          hostId: "host-bad",
          exists: true,
          revoked: true,
          authorizedForProject: true,
          online: true,
          capabilities: ["shell"],
          displayName: "Revoked Host"
        }
      ],
      nextHumanCursor: null,
      nextHostCursor: null
    },
    status: connectedStatus(),
    syncPhase: "ready",
    loading: false,
    pending: false,
    staleConflict: false,
    lastError: null
  });
}

function renderPicker(
  viewModel: AssigneePickerViewModel,
  handlers: {
    onSelect?: ReturnType<typeof vi.fn>;
    onRefresh?: ReturnType<typeof vi.fn>;
    onRetry?: ReturnType<typeof vi.fn>;
    query?: string;
    onQueryChange?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const onSelect = handlers.onSelect ?? vi.fn().mockResolvedValue(true);
  const onRefresh = handlers.onRefresh ?? vi.fn().mockResolvedValue(undefined);
  const onRetry = handlers.onRetry ?? vi.fn().mockResolvedValue(true);
  const onQueryChange = handlers.onQueryChange ?? vi.fn();
  render(
    <AssigneePicker
      viewModel={viewModel}
      query={handlers.query ?? ""}
      onQueryChange={onQueryChange}
      onSelect={onSelect}
      onRefresh={onRefresh}
      onRetry={onRetry}
      t={t}
    />
  );
  return { onSelect, onRefresh, onRetry, onQueryChange };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("AssigneePicker", () => {
  it("supports keyboard typeahead focus and Task people selection", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    const { onSelect, onQueryChange } = renderPicker(taskViewModel({ query: "grace" }), {
      query: "grace"
    });

    await user.click(screen.getByTestId("assignee-picker-trigger"));
    const search = await screen.findByTestId("assignee-search");
    expect(search).toHaveFocus();

    await user.clear(search);
    await user.type(search, "ada");
    expect(onQueryChange).toHaveBeenCalled();

    const options = screen.getAllByTestId("assignee-option");
    const grace = options.find((node) => node.getAttribute("data-option-id") === "human:human-2");
    expect(grace).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    // Enter on active option (first filtered result is Grace)
    expect(onSelect).toHaveBeenCalledWith({
      kind: "human",
      humanPrincipalId: "human-2"
    });
  });

  it("does not expose Block Host or automatic sections", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    renderPicker(blockViewModel());

    await user.click(screen.getByTestId("assignee-picker-trigger"));
    expect(await screen.findByTestId("assignee-section-people")).toBeInTheDocument();
    expect(screen.queryByTestId("assignee-section-hosts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assignee-section-automatic")).not.toBeInTheDocument();
  });

  it("does not offer host sections for Tasks", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    renderPicker(taskViewModel());
    await user.click(screen.getByTestId("assignee-picker-trigger"));
    expect(screen.queryByTestId("assignee-section-hosts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("assignee-section-automatic")).not.toBeInTheDocument();
  });

  it("shows role authorization block and stale conflict refresh/retry", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    const unauthorized = taskViewModel({
      status: connectedStatus("outsider")
    });
    renderPicker(unauthorized);
    expect(screen.getByTestId("assignee-picker")).toHaveAttribute("data-mode", "ready");
    await user.click(screen.getByTestId("assignee-picker-trigger"));
    const options = screen.getAllByTestId("assignee-option");
    expect(options.every((node) => node.getAttribute("data-selectable") === "false")).toBe(true);

    const stale = taskViewModel({ staleConflict: true, syncPhase: "stale_conflict" });
    const { onRefresh, onRetry } = renderPicker(stale);
    expect(screen.getByTestId("assignee-stale-actions")).toBeInTheDocument();
    await user.click(screen.getByTestId("assignee-refresh"));
    expect(onRefresh).toHaveBeenCalled();
    await user.click(screen.getByTestId("assignee-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("shows offline and unavailable member issues on the current assignment", () => {
    const offline = taskViewModel({
      assignment: {
        projectId: "project-1",
        workItem: taskItem,
        target: { kind: "human", humanPrincipalId: "gone" },
        revision: 5,
        human: {
          humanPrincipalId: "gone",
          displayName: "Former Member",
          membershipActive: false
        },
        availability: { status: "invalid", reason: "human_membership_inactive" }
      }
    });
    renderPicker(offline);
    expect(screen.getByTestId("assignee-current-label")).toHaveTextContent("Former Member");
    expect(screen.getByTestId("assignee-current-issue")).toHaveTextContent(/no longer active/i);
  });

  it("disables duplicate submits while pending", async () => {
    stubSelectLayoutApis();
    const pending = taskViewModel({ pending: true });
    renderPicker(pending);
    expect(screen.getByTestId("assignee-picker-trigger")).toBeDisabled();
    expect(screen.getByTestId("assignee-current-label")).toHaveTextContent(/Updating assignee/i);
  });

  it("localizes zh-CN labels for the assignee surface", () => {
    const zh = createTranslator("zh-CN");
    expect(zh("assignee")).toBe("负责人");
    expect(zh("assigneeStaleConflict")).toMatch(/刷新/);
    expect(zh("assigneeSectionHosts")).toMatch(/Host/);
  });
});
