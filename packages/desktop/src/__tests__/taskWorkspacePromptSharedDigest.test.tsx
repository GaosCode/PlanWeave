/* @vitest-environment jsdom */
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  applyCanvasReplicaIntent,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument
} from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  CanvasReplicaCommandWorker,
  type CanvasReplicaCommandTransport
} from "../main/collaboration/CanvasReplicaCommandWorker.js";
import {
  CanvasReplicaStore,
  type CanvasReplicaScope
} from "../main/collaboration/CanvasReplicaStore.js";
import type { WorkspaceCanvasProjection } from "../shared/workspaceCanvasProjection";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator";
import {
  useWorkspaceCanvasCommands,
  type WorkspaceCanvasCommandBridge
} from "../renderer/hooks/useWorkspaceCanvasCommands";
import { useTaskWorkspacePromptActions } from "../renderer/task-workspace/useTaskWorkspacePromptActions";
import { createTranslator } from "../renderer/i18n";
import {
  TaskWorkspaceTaskPrompt,
  TaskWorkspaceBlockPrompts
} from "../renderer/task-workspace/TaskWorkspacePrompts";
import { taskWorkspaceLabels } from "../renderer/task-workspace/labels";
import { taskWorkspaceInspectorFixture } from "./helpers/taskWorkspaceInspectorFixture";
import { controllerApi } from "./helpers/taskWorkspaceControllerHarness";
import { deferred } from "./helpers/desktopProjectFixtures";

const scope: CanvasReplicaScope = {
  authorityId: "authority-a",
  localProjectId: "local-project",
  localCanvasId: "local-canvas",
  projectId: "project-authority",
  canvasId: "default",
  workspaceId: "workspace-authority"
};
const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-a",
  workspaceId: scope.workspaceId,
  projectId: scope.projectId,
  canvasId: scope.canvasId
};
const t = createTranslator("en");
const workers: CanvasReplicaCommandWorker[] = [];
afterEach(() => {
  cleanup();
  for (const worker of workers.splice(0)) worker.clearAll();
});

type Kind = "task" | "block";
type Publication = "none" | "main-first" | "renderer-first";
function intentFor(kind: Kind, promptMarkdown: string): CanvasCommandIntent {
  return kind === "task"
    ? { kind: "update_task_prompt", taskId: "T-001", promptMarkdown }
    : { kind: "update_block_prompt", blockRef: "T-001#B-001", promptMarkdown };
}
function snapshot(
  content: CompleteContentVersion,
  revision: number
): Extract<CanvasReconnectResponse, { type: "canvas.reconnect.snapshot" }> {
  const serverScope = {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId
  };
  return {
    type: "canvas.reconnect.snapshot",
    protocolVersion: 1,
    schemaVersion: "canvas-command/v1",
    scope: serverScope,
    reason: "truncated_journal",
    afterRevision: 0,
    snapshot: {
      metadata: {
        schemaVersion: "canvas-snapshot/v2",
        scope: serverScope,
        revision,
        contentDigest: content.canonicalDigest,
        createdAt: "2026-08-02T00:00:00.000Z",
        sizeBytes: content.totalBytes
      },
      encoding: "content_version_ref",
      content: {
        versionId: `version-${content.canonicalDigest}`,
        canonicalDigest: content.canonicalDigest,
        verification: "complete"
      }
    }
  };
}

async function harness(kind: Kind, publication: Publication) {
  const manifest = basicManifest();
  let document = parseCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath: Object.fromEntries(
      manifest.nodes.flatMap((task) => [
        [task.prompt, "initial"],
        ...task.blocks.map((block) => [block.prompt, "initial"])
      ])
    ),
    layout: {
      version: "desktop-layout/v1",
      projectId: scope.projectId,
      nodes: [],
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
  });
  let content = encodeCanvasReplicaDocument(document);
  let revision = 5;
  const initialDigest = content.canonicalDigest;
  let acceptedDigest: string | null = null;
  const store = new CanvasReplicaStore(() => undefined);
  const pending = deferred<void>();
  const submitted: Array<{ expectedRevision: number; intent: CanvasCommandIntent }> = [];
  const outcomes: CanvasCommandOutcome[] = [];
  const transport: CanvasReplicaCommandTransport = {
    fetchReconnectBaseline: async () => ({ response: snapshot(content, revision), content }),
    reconnect: async () => ({ response: snapshot(content, revision), snapshotContent: content }),
    canPersistCanvasCommand: async () => true,
    submit: async (input) => {
      submitted.push({ expectedRevision: input.expectedRevision, intent: input.intent });
      if (submitted.length === 1) await pending.promise;
      const common = {
        protocolVersion: 1 as const,
        schemaVersion: "canvas-command/v1" as const,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        operationId: input.operationId
      };
      if (
        (input.intent.kind === "update_task_prompt" ||
          input.intent.kind === "update_block_prompt") &&
        input.intent.baseContentDigest !== undefined &&
        input.intent.baseContentDigest !== content.canonicalDigest
      ) {
        const rejected: CanvasCommandOutcome = {
          ...common,
          type: "canvas.command.rejected",
          code: "operation_conflict",
          detail: "base_content_digest_mismatch"
        };
        outcomes.push(rejected);
        return rejected;
      }
      document = applyCanvasReplicaIntent(document, input.intent);
      content = encodeCanvasReplicaDocument(document);
      revision += 1;
      if (submitted.length === 1) acceptedDigest = content.canonicalDigest;
      const accepted: CanvasCommandOutcome = {
        ...common,
        type: "canvas.command.accepted",
        scope: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          canvasId: scope.canvasId
        },
        revision,
        previousRevision: revision - 1,
        contentDigest: content.canonicalDigest,
        journalEntryId: `journal-${revision}`,
        actor: { kind: "human", id: "owner", displayName: "Owner" },
        acceptedAt: "2026-08-02T00:00:00.000Z",
        idempotentReplay: false
      };
      outcomes.push(accepted);
      return accepted;
    }
  };
  const worker = new CanvasReplicaCommandWorker(store, transport);
  workers.push(worker);
  await worker.bind(scope);
  function projection(
    status: WorkspaceCanvasProjection["status"] = "accepted",
    rejectCode: WorkspaceCanvasProjection["rejectCode"] = null
  ): WorkspaceCanvasProjection {
    const replica = store.projection(scope);
    if (!replica) throw new Error("Missing replica");
    return {
      locator,
      status,
      authorityMode: "server_authoritative",
      readOnly: false,
      cachedAt: null,
      initialRuntimeAvailability: null,
      conflict: null,
      rejectCode,
      replica
    };
  }
  function installExternal() {
    document = applyCanvasReplicaIntent(document, intentFor(kind, "C"));
    content = encodeCanvasReplicaDocument(document);
    revision += 1;
    store.installBaseline(scope, { content, revision, contentDigest: content.canonicalDigest });
  }
  let signal:
    | Parameters<WorkspaceCanvasCommandBridge["onWorkspaceCanvasProjectionSignal"]>[0]
    | null = null;
  let commandCount = 0;
  const bridge: WorkspaceCanvasCommandBridge = {
    openWorkspaceCanvasSession: async () => projection(),
    reconnectWorkspaceCanvasSession: async () => projection(),
    closeWorkspaceCanvasSession: async () => undefined,
    onWorkspaceCanvasProjectionSignal: (callback) => {
      signal = callback;
      return () => {
        signal = null;
      };
    },
    submitWorkspaceCanvasCommand: async ({ intent }) => {
      commandCount += 1;
      if (commandCount === 2 && publication === "main-first") installExternal();
      const result = await worker.submit(scope, intent, { retryStale: false });
      if (commandCount === 1 && publication === "renderer-first") {
        installExternal();
        signal?.({ type: "workspace.canvas.projection", projection: projection() });
      }
      return result.type === "canvas.command.accepted"
        ? projection()
        : projection("rejected", result.code);
    }
  };
  const fixture = taskWorkspaceInspectorFixture();
  const workspace = {
    ...fixture.workspace,
    project: {
      authority: "workspace" as const,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    }
  };
  const api = controllerApi({ readModel: () => null }).api;
  const hook = renderHook(() => {
    const gate = useWorkspaceCanvasCommands({
      api: bridge,
      locator,
      authorityKey: "shared-digest",
      sessionConnected: true,
      t
    });
    return {
      gate,
      actions: useTaskWorkspacePromptActions({
        api,
        authority: { canvasLocator: locator, projectRoot: null, workspaceRoot: null },
        navigation: {
          authority: "workspace",
          ...locator,
          taskId: "T-001",
          source: { view: "graph" }
        },
        workspace,
        workspaceCanvas: gate,
        onLocalSaved: () => undefined
      })
    };
  });
  await waitFor(() => expect(hook.result.current.gate.projection).not.toBeNull());
  const actions = hook.result.current.actions;
  const writer =
    kind === "task"
      ? actions.saveTaskPrompt
      : (input: Parameters<typeof actions.saveTaskPrompt>[0]) =>
          actions.saveBlockPrompt("T-001#B-001", input);
  const draft = actions.getPromptDraft(kind === "task" ? null : "T-001#B-001", "initial", writer);
  let saved!: Promise<void>;
  act(() => {
    draft.edit("A");
    saved = draft.save();
    draft.edit("AB");
    void draft.save();
  });
  await waitFor(() => expect(submitted).toHaveLength(1));
  await act(async () => {
    pending.resolve();
    await saved;
  });
  return {
    submitted,
    outcomes,
    draft,
    initialDigest,
    acceptedDigest,
    hook,
    markdown: () =>
      kind === "task"
        ? store.projection(scope)?.content.tasks[0]?.promptMarkdown
        : store.projection(scope)?.content.blockPromptMarkdownByRef["T-001#B-001"],
    revision: () => revision,
    api,
    showEditor: () => {
      const labels = taskWorkspaceLabels(t).promptLabels;
      return render(
        kind === "task" ? (
          <TaskWorkspaceTaskPrompt
            task={{ ...fixture.workspace.task, promptMarkdown: "C" }}
            labels={labels}
            owner={draft}
          />
        ) : (
          <TaskWorkspaceBlockPrompts
            block={{ ...fixture.selectedRun.block, promptMarkdown: "C" }}
            labels={labels}
            owner={draft}
          />
        )
      );
    }
  };
}

it.each([
  "task",
  "block"
] as const)("keeps external C and the queued %s draft when main receives C before renderer", async (kind) => {
  const h = await harness(kind, "main-first");
  expect(h.markdown()).toBe("C");
  expect(h.revision()).toBe(7);
  expect(h.submitted.map((item) => item.expectedRevision)).toEqual([5, 7]);
  expect(h.outcomes[1]).toMatchObject({
    type: "canvas.command.rejected",
    code: "operation_conflict",
    detail: "base_content_digest_mismatch"
  });
  expect(h.draft.getSnapshot()).toMatchObject({
    draft: "AB",
    baseline: "A",
    status: "error",
    pending: false
  });
  expect(h.draft.getSnapshot().error).toContain("operation_conflict");
  h.showEditor();
  expect(screen.getByRole("alert").textContent).toContain("operation_conflict");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("AB");
  expect(h.submitted[1]?.intent).toMatchObject({ baseContentDigest: h.acceptedDigest });
  expect(h.api.updateTaskPrompt).not.toHaveBeenCalled();
  expect(h.api.updateBlockPrompt).not.toHaveBeenCalled();
});

it.each([
  "task",
  "block"
] as const)("keeps external C and the queued %s draft when renderer sees C before confirmation", async (kind) => {
  const h = await harness(kind, "renderer-first");
  expect(h.markdown()).toBe("C");
  expect(h.submitted).toHaveLength(1);
  expect(h.draft.getSnapshot()).toMatchObject({ draft: "AB", status: "error", pending: false });
  expect(h.draft.getSnapshot().error).toContain("changed before its save was confirmed");
});

it.each([
  "task",
  "block"
] as const)("drains %s A then AB using each confirmed digest when no external writer intervenes", async (kind) => {
  const h = await harness(kind, "none");
  expect(h.markdown()).toBe("AB");
  expect(h.submitted.map((item) => item.expectedRevision)).toEqual([5, 6]);
  expect(h.submitted[0]?.intent).toMatchObject({ baseContentDigest: h.initialDigest });
  expect(h.submitted[1]?.intent).toMatchObject({ baseContentDigest: h.acceptedDigest });
  expect(h.draft.getSnapshot()).toMatchObject({
    draft: "AB",
    baseline: "AB",
    status: "saved",
    error: null
  });
});
