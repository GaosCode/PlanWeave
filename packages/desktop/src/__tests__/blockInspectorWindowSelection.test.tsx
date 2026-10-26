/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type {
  DesktopAutoRunEvent,
  DesktopBlockDetail,
  DesktopBridgeApi,
  DesktopRunRecord
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlockInspector } from "../renderer/inspector/BlockInspector";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { selectedBlock, autoRunEvent, autoRunState } from "./helpers/autoRunControlHarness";
import { deferred } from "./helpers/desktopProjectFixtures";
import { graph } from "./helpers/graphFixtures";
import { record } from "./helpers/taskWorkspaceConversationFixture";

type InspectorProps = ComponentProps<typeof BlockInspector>;
let inspector: InspectorProps;

vi.mock("../renderer/inspector/BlockInspector", () => ({
  BlockInspector: (props: InspectorProps) => {
    inspector = props;
    return (
      <output>
        {props.selectedBlock?.ref} {props.selectedBlock?.title} {props.selectedRunRecord?.recordId}{" "}
        {props.error}
      </output>
    );
  }
}));
vi.mock("../renderer/hooks/useDesktopSettingsBridge", () => ({
  useDesktopSettingsBridge: () => ({
    settings: defaultDesktopSettings,
    updateSettingsAndWait: vi.fn()
  })
}));

const alpha: DesktopBlockDetail = {
  ...selectedBlock,
  graphVersion: "pgv-before",
  promptHash: "hash-before"
};
const beta: DesktopBlockDetail = {
  ...alpha,
  ref: "T-BETA#B-001",
  taskId: "T-BETA",
  title: "Beta",
  promptMarkdown: "# Beta"
};

function run(runId: string): DesktopRunRecord {
  return record(null, {
    recordId: `${alpha.ref}::${runId}`,
    ref: alpha.ref,
    taskId: alpha.taskId,
    blockId: alpha.blockId,
    runId,
    projectRoot: "/tmp/demo"
  });
}

async function openWindow(overrides: Partial<DesktopBridgeApi> = {}) {
  const bridge = createDesktopBridgeMock({
    getGraphViewModel: vi.fn().mockResolvedValue(graph),
    getBlockDetail: vi.fn((_canvas, ref) => Promise.resolve(ref === beta.ref ? beta : alpha)),
    listBlockRunRecords: vi.fn().mockResolvedValue([]),
    getReviewAttempts: vi.fn().mockResolvedValue([]),
    getFeedbackRecords: vi.fn().mockResolvedValue([]),
    ...overrides
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  window.history.replaceState(
    {},
    "",
    `/?projectRoot=/tmp/demo&canvasId=canvas-main&blockRef=${encodeURIComponent(alpha.ref)}`
  );
  const { BlockInspectorWindow } = await import("../renderer/BlockInspectorWindow");
  const view = render(<BlockInspectorWindow />);
  await waitFor(() => expect(inspector.selectedBlock?.ref).toBe(alpha.ref));
  return { bridge, ...view, Window: BlockInspectorWindow };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Block Inspector window selection ownership", () => {
  it.each([
    "resolve",
    "reject"
  ] as const)("keeps newer history when an older window read %s", async (completion) => {
    const older = deferred<DesktopRunRecord>();
    const newer = run("RUN-002");
    await openWindow({
      getRunRecord: vi
        .fn()
        .mockImplementationOnce(() => older.promise)
        .mockResolvedValue(newer)
    });
    let reading!: Promise<void>;
    act(() => {
      reading = inspector.handleOpenRunRecord(run("RUN-001").recordId);
    });
    await act(async () => {
      await inspector.handleOpenRunRecord(newer.recordId);
    });
    expect(screen.getByText(new RegExp(newer.recordId))).toBeTruthy();
    await act(async () => {
      if (completion === "resolve") older.resolve(run("RUN-001"));
      else older.reject(new Error("old history failure"));
      await reading;
    });
    expect(inspector.selectedRunRecord?.recordId).toBe(newer.recordId);
    expect(inspector.error).not.toBe("old history failure");
  });

  it.each(
    (["clear", "block", "scope"] as const).flatMap((boundary) =>
      (["resolve", "reject"] as const).map((completion) => ({ boundary, completion }))
    )
  )("retires older history $completion after $boundary", async ({ boundary, completion }) => {
    const older = deferred<DesktopRunRecord>();
    const { rerender, Window } = await openWindow({ getRunRecord: vi.fn(() => older.promise) });
    let reading!: Promise<void>;
    act(() => {
      reading = inspector.handleOpenRunRecord(run("RUN-001").recordId);
    });
    if (boundary === "clear") {
      act(() => inspector.setSelectedRunRecord(null));
    } else if (boundary === "block") {
      await act(async () => {
        await inspector.onBlockSelect?.(beta.ref);
      });
    } else {
      window.history.replaceState(
        {},
        "",
        `/?projectRoot=/tmp/other&canvasId=canvas-other&blockRef=${encodeURIComponent(alpha.ref)}`
      );
      await act(async () => {
        rerender(<Window />);
      });
    }
    await act(async () => {
      if (completion === "resolve") older.resolve(run("RUN-001"));
      else older.reject(new Error("retired history failure"));
      await reading;
    });
    expect(inspector.selectedRunRecord).toBeNull();
    expect(inspector.error).not.toBe("retired history failure");
    if (boundary === "block") expect(inspector.selectedBlock?.ref).toBe(beta.ref);
  });

  it.each([
    "resolve",
    "reject"
  ] as const)("keeps a foreground history selection after background Auto Run refresh %s", async (completion) => {
    const background = deferred<DesktopRunRecord>();
    let listener!: (event: DesktopAutoRunEvent) => void;
    const first = run("RUN-001");
    const second = run("RUN-002");
    await openWindow({
      getRunRecord: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(() => background.promise)
        .mockResolvedValue(second),
      onAutoRunChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    });
    await act(async () => {
      await inspector.handleOpenRunRecord(first.recordId);
    });
    await act(async () => {
      listener(
        autoRunEvent(autoRunState({ currentRef: alpha.ref, latestRecordId: first.recordId }))
      );
    });
    await act(async () => {
      await inspector.handleOpenRunRecord(second.recordId);
    });
    await act(async () => {
      if (completion === "resolve") background.resolve(first);
      else background.reject(new Error("retired Auto Run history failure"));
    });
    expect(inspector.selectedRunRecord?.recordId).toBe(second.recordId);
    expect(inspector.error).not.toBe("retired Auto Run history failure");
  });

  it("does not let an Auto Run detail refresh cancel a pending foreground Block selection", async () => {
    const selecting = deferred<DesktopBlockDetail>();
    let listener!: (event: DesktopAutoRunEvent) => void;
    const { bridge } = await openWindow({
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(alpha)
        .mockImplementationOnce(() => selecting.promise)
        .mockRejectedValue(new Error("background refresh failure")),
      onAutoRunChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    });
    let selection!: Promise<void>;
    act(() => {
      selection = Promise.resolve(inspector.onBlockSelect?.(beta.ref));
    });
    await act(async () => {
      listener(autoRunEvent(autoRunState({ currentRef: beta.ref })));
    });
    await act(async () => {
      selecting.resolve(beta);
      await selection;
    });
    expect(inspector.selectedBlock?.ref).toBe(beta.ref);
    expect(inspector.error).toBeNull();
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(2);
  });

  it.each([
    "block",
    "scope",
    "unmount"
  ] as const)("does not start reads from an escaped Auto Run callback after %s", async (boundary) => {
    let listener!: (event: DesktopAutoRunEvent) => void;
    const first = run("RUN-001");
    const { bridge, rerender, Window, unmount } = await openWindow({
      getRunRecord: vi.fn().mockResolvedValue(first),
      onAutoRunChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    });
    await act(async () => {
      await inspector.handleOpenRunRecord(first.recordId);
    });
    const escaped = listener;
    if (boundary === "block") {
      await act(async () => {
        await inspector.onBlockSelect?.(beta.ref);
      });
    } else if (boundary === "scope") {
      window.history.replaceState(
        {},
        "",
        `/?projectRoot=/tmp/other&canvasId=canvas-other&blockRef=${encodeURIComponent(alpha.ref)}`
      );
      await act(async () => {
        rerender(<Window />);
      });
    } else unmount();
    const recordReads = vi.mocked(bridge.getRunRecord).mock.calls.length;
    const blockReads = vi.mocked(bridge.getBlockDetail).mock.calls.length;
    await act(async () => {
      escaped(
        autoRunEvent(autoRunState({ currentRef: alpha.ref, latestRecordId: first.recordId }))
      );
    });
    expect(bridge.getRunRecord).toHaveBeenCalledTimes(recordReads);
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(blockReads);
  });

  it.each([
    "write",
    "reload"
  ] as const)("does not restore an old Block when its prompt save %s finishes", async (stage) => {
    const write = deferred<Awaited<ReturnType<DesktopBridgeApi["updateBlockPrompt"]>>>();
    const reload = deferred<DesktopBlockDetail>();
    const { bridge } = await openWindow({
      getBlockDetail: vi.fn((_canvas, ref) =>
        ref === beta.ref ? Promise.resolve(beta) : Promise.resolve(alpha)
      ),
      updateBlockPrompt: vi.fn().mockImplementation(() => write.promise)
    });
    let saving!: Promise<void>;
    act(() => {
      saving = inspector.saveSelectedBlockPrompt();
    });
    if (stage === "reload") {
      vi.mocked(bridge.getBlockDetail).mockImplementationOnce(() => reload.promise);
      await act(async () => {
        write.resolve({ ok: true, affectedTasks: [alpha.taskId], diagnostics: [] });
      });
    }
    await act(async () => {
      await inspector.onBlockSelect?.(beta.ref);
    });
    act(() => {
      inspector.onDraftDirtyChange?.(true);
      inspector.setSelectedBlock({ ...beta, promptMarkdown: "# New Beta draft" });
    });
    const reads = vi.mocked(bridge.getBlockDetail).mock.calls.length;
    await act(async () => {
      if (stage === "write")
        write.resolve({ ok: true, affectedTasks: [alpha.taskId], diagnostics: [] });
      else reload.resolve(alpha);
      await saving;
    });
    expect(inspector.selectedBlock).toMatchObject({
      ref: beta.ref,
      promptMarkdown: "# New Beta draft"
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(reads);
  });

  it("does not reload a saved Block after its window unmounts", async () => {
    const write = deferred<Awaited<ReturnType<DesktopBridgeApi["updateBlockPrompt"]>>>();
    const { bridge, unmount } = await openWindow({ updateBlockPrompt: vi.fn(() => write.promise) });
    let saving!: Promise<void>;
    act(() => {
      saving = inspector.saveSelectedBlockPrompt();
    });
    unmount();
    await act(async () => {
      write.resolve({ ok: true, affectedTasks: [alpha.taskId], diagnostics: [] });
      await saving;
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledOnce();
  });

  it("preserves newer prompt and title edits while accepting saved canonical hashes", async () => {
    const canonical = deferred<DesktopBlockDetail>();
    let listener!: (event: DesktopAutoRunEvent) => void;
    const { bridge } = await openWindow({
      onAutoRunChanged: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      }),
      getBlockDetail: vi
        .fn()
        .mockResolvedValueOnce(alpha)
        .mockImplementationOnce(() => canonical.promise),
      updateBlockPrompt: vi
        .fn()
        .mockResolvedValue({ ok: true, affectedTasks: [alpha.taskId], diagnostics: [] })
    });
    const oldDirtyCallback = inspector.onDraftDirtyChange;
    let saving!: Promise<void>;
    await act(async () => {
      saving = inspector.saveSelectedBlockPrompt();
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(2);
    act(() => {
      inspector.setSelectedBlock({
        ...alpha,
        title: "New title",
        promptMarkdown: "# New unsaved draft"
      });
      inspector.onDraftDirtyChange?.(true);
    });
    await act(async () => {
      canonical.resolve({ ...alpha, graphVersion: "pgv-saved", promptHash: "hash-saved" });
      await saving;
    });
    expect(inspector.selectedBlock).toMatchObject({
      title: "New title",
      promptMarkdown: "# New unsaved draft",
      graphVersion: "pgv-saved",
      promptHash: "hash-saved"
    });
    await act(async () => {
      oldDirtyCallback?.(false);
      listener(autoRunEvent(autoRunState({ currentRef: alpha.ref })));
    });
    expect(bridge.getBlockDetail).toHaveBeenCalledTimes(2);
  });
});
