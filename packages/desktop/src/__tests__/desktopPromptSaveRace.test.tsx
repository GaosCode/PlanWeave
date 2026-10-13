/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopBridgeApi, ProjectPromptPolicy } from "@planweave-ai/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopBridgeMock } from "./desktopBridgeMock";
import { deferred, project, projectSnapshot } from "./helpers/desktopProjectFixtures";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { defaultDesktopSettings } from "../renderer/settings";
import { createTranslator } from "../renderer/i18n";

afterEach(cleanupRendererTestEnvironment);

async function harness() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const bridge = createDesktopBridgeMock({
    listProjects: vi.fn().mockResolvedValue([]),
    readGlobalPrompt: vi.fn().mockResolvedValue("global-base"),
    updateGlobalPrompt: vi.fn<DesktopBridgeApi["updateGlobalPrompt"]>(async (text) => text),
    updateProjectPrompt: vi.fn<DesktopBridgeApi["updateProjectPrompt"]>(async (_, text) => text),
    updateProjectPromptPolicy: vi.fn<DesktopBridgeApi["updateProjectPromptPolicy"]>(
      async (_, patch) => ({ includeGlobalPrompt: patch.includeGlobalPrompt !== false })
    ),
    getDesktopProjectSnapshot: vi.fn<DesktopBridgeApi["getDesktopProjectSnapshot"]>(async (ref) =>
      projectSnapshot({
        projectPromptMarkdown: `base-${ref.projectRoot}`,
        projectPromptPolicy: { includeGlobalPrompt: true }
      })
    )
  });
  vi.stubGlobal("planweave", bridge);
  vi.resetModules();
  const { useGlobalPrompt } = await import("../renderer/hooks/useGlobalPrompt");
  const { useDesktopProject } = await import("../renderer/hooks/useDesktopProject");
  const { SettingsView } = await import("../renderer/views/SettingsView");
  const setError = vi.fn();
  const updateSettings = vi.fn();
  const t = createTranslator("en");
  let current!: ReturnType<typeof useDesktopProject> & ReturnType<typeof useGlobalPrompt>;
  function App({ home }: { home: string }) {
    const local = useDesktopProject({
      planweaveHome: home,
      setError,
      t,
      updateSettings,
      autoSelectInitialProject: false
    });
    const global = useGlobalPrompt(setError, home);
    current = { ...local, ...global };
    return (
      <SettingsView
        agentDetectionRefreshing={false}
        agents={[]}
        graph={local.graph}
        language="en"
        refreshAgentDetections={async () => undefined}
        refreshRuntimeTools={async () => undefined}
        runtimeTools={{ tmux: { available: true, command: "tmux" } }}
        projects={[project]}
        selectedProject={local.selectedProject}
        selectedCanvasId={local.selectedCanvasId}
        loadProject={local.loadProject}
        setActiveView={vi.fn()}
        setError={setError}
        settings={{ ...defaultDesktopSettings, planweaveHome: home }}
        t={t}
        updateSettings={updateSettings}
        updateSettingsAndWait={async () => undefined}
        globalPromptMarkdown={global.globalPromptMarkdown}
        updateGlobalPrompt={global.updateGlobalPrompt}
        projectPromptMarkdown={local.projectPromptMarkdown}
        projectPromptPolicy={local.projectPromptPolicy}
        updateProjectPrompt={local.updateProjectPrompt}
        updateProjectPromptPolicy={local.updateProjectPromptPolicy}
      />
    );
  }
  const view = render(<App home="home-a" />);
  await waitFor(() => expect(current.globalPromptMarkdown).toBe("global-base"));
  await act(async () => {
    await current.loadProject(project);
  });
  setError.mockClear();
  return {
    bridge,
    view,
    setError,
    get current() {
      return current;
    },
    setHome(home: string) {
      view.rerender(<App home={home} />);
    },
    async selectProjectInHome(home: string) {
      const registeredProject = { ...project, workspaceRoot: `/${home}/workspace` };
      vi.mocked(bridge.listProjects).mockResolvedValueOnce([registeredProject]);
      view.rerender(<App home={home} />);
      await waitFor(() => expect(current.projects).toEqual([registeredProject]));
      expect(current.selectedProject).toBeNull();
      expect(current.projectPromptMarkdown).toBeNull();
      await act(async () => {
        await current.loadProject(registeredProject);
      });
    }
  };
}
function textbox(kind: "Global" | "Project") {
  return screen.getByRole("textbox", { name: `${kind} Prompt` });
}
function save(kind: "Global" | "Project") {
  fireEvent.click(screen.getByRole("button", { name: `Save ${kind} Prompt` }));
}

it.each([
  "Global",
  "Project"
] as const)("preserves newer %s draft after pending save ACK", async (kind) => {
  const h = await harness();
  const pending = deferred<string>();
  if (kind === "Global")
    vi.mocked(h.bridge.updateGlobalPrompt).mockReturnValueOnce(pending.promise);
  else vi.mocked(h.bridge.updateProjectPrompt).mockReturnValueOnce(pending.promise);
  fireEvent.change(textbox(kind), { target: { value: "saved-A" } });
  save(kind);
  fireEvent.change(textbox(kind), { target: { value: "draft-B" } });
  await act(async () => {
    pending.resolve("saved-A");
    await pending.promise;
  });
  expect(textbox(kind)).toHaveValue("draft-B");
  save(kind);
  if (kind === "Global") expect(h.bridge.updateGlobalPrompt).toHaveBeenLastCalledWith("draft-B");
  else expect(h.bridge.updateProjectPrompt).toHaveBeenLastCalledWith(project.rootPath, "draft-B");
});

it("discards a Project save ACK after loading another project", async () => {
  const h = await harness();
  const pending = deferred<string>();
  vi.mocked(h.bridge.updateProjectPrompt).mockReturnValueOnce(pending.promise);
  fireEvent.change(textbox("Project"), { target: { value: "saved-A" } });
  save("Project");
  const other = { ...project, projectId: "P-B", rootPath: "/tmp/b", sourceRoot: "/tmp/b" };
  await act(async () => {
    await h.current.loadProject(other);
  });
  await act(async () => {
    pending.resolve("saved-A");
    await pending.promise;
  });
  expect(h.current.projectPromptMarkdown).toBe("base-/tmp/b");
  expect(textbox("Project")).toHaveValue("base-/tmp/b");
});

it("discards a Global save ACK after changing Home", async () => {
  const h = await harness();
  const pending = deferred<string>();
  vi.mocked(h.bridge.updateGlobalPrompt).mockReturnValueOnce(pending.promise);
  fireEvent.change(textbox("Global"), { target: { value: "saved-A" } });
  save("Global");
  vi.mocked(h.bridge.readGlobalPrompt).mockResolvedValueOnce("home-B");
  h.setHome("home-b");
  await waitFor(() => expect(h.current.globalPromptMarkdown).toBe("home-B"));
  await act(async () => {
    pending.resolve("saved-A");
    await pending.promise;
  });
  expect(h.current.globalPromptMarkdown).toBe("home-B");
  expect(textbox("Global")).toHaveValue("home-B");
});

it.each([
  "Global",
  "Project"
] as const)("keeps dirty %s text through external authority and follows it when clean", async (kind) => {
  const h = await harness();
  async function publish(text: string) {
    await act(async () => {
      if (kind === "Global") await h.current.updateGlobalPrompt(text);
      else await h.current.updateProjectPrompt(text);
    });
  }
  await publish("clean-external");
  expect(textbox(kind)).toHaveValue("clean-external");
  fireEvent.change(textbox(kind), { target: { value: "dirty-local" } });
  await publish("dirty-external");
  expect(textbox(kind)).toHaveValue("dirty-local");
  await act(async () => {
    save(kind);
  });
  expect(textbox(kind)).toHaveValue("dirty-local");
  await publish("after-confirmation");
  expect(textbox(kind)).toHaveValue("after-confirmation");
});

it.each([
  "Global",
  "Project"
] as const)("preserves %s draft and exposes current save failure", async (kind) => {
  const h = await harness();
  if (kind === "Global")
    vi.mocked(h.bridge.updateGlobalPrompt).mockRejectedValueOnce(new Error("save failed"));
  else vi.mocked(h.bridge.updateProjectPrompt).mockRejectedValueOnce(new Error("save failed"));
  fireEvent.change(textbox(kind), { target: { value: "unsaved" } });
  await act(async () => {
    save(kind);
  });
  expect(textbox(kind)).toHaveValue("unsaved");
  expect(h.setError).toHaveBeenCalledWith("save failed");
  expect(screen.getByRole("button", { name: `Save ${kind} Prompt` })).toBeEnabled();
  await act(async () => {
    if (kind === "Global") await h.current.updateGlobalPrompt("external");
    else await h.current.updateProjectPrompt("external");
  });
  expect(textbox(kind)).toHaveValue("unsaved");
});

type WriteKind = "Global" | "Project" | "Policy";
function pendingWrite(h: Awaited<ReturnType<typeof harness>>, kind: WriteKind) {
  if (kind === "Policy") {
    const pending = deferred<ProjectPromptPolicy>();
    vi.mocked(h.bridge.updateProjectPromptPolicy).mockReturnValueOnce(pending.promise);
    return {
      resolve: () => pending.resolve({ includeGlobalPrompt: false }),
      reject: () => pending.reject(new Error("stale write"))
    };
  }
  const pending = deferred<string>();
  if (kind === "Global")
    vi.mocked(h.bridge.updateGlobalPrompt).mockReturnValueOnce(pending.promise);
  else vi.mocked(h.bridge.updateProjectPrompt).mockReturnValueOnce(pending.promise);
  return {
    resolve: () => pending.resolve("stale-body"),
    reject: () => pending.reject(new Error("stale write"))
  };
}
function write(h: Awaited<ReturnType<typeof harness>>, kind: WriteKind, body = "body") {
  if (kind === "Global") return h.current.updateGlobalPrompt(body);
  if (kind === "Project") return h.current.updateProjectPrompt(body);
  return h.current.updateProjectPromptPolicy({ includeGlobalPrompt: body === "latest" });
}

for (const kind of ["Global", "Project", "Policy"] as const) {
  for (const invalidation of ["scope", "roundtrip", "unmount", "newer"] as const) {
    it.each([
      "resolve",
      "reject"
    ] as const)(`ignores stale ${kind} %s after ${invalidation}`, async (outcome) => {
      const h = await harness();
      const pending = pendingWrite(h, kind);
      let task!: Promise<unknown>;
      act(() => {
        task = write(h, kind);
      });
      const observed = task.catch((error: unknown) => error);
      if (invalidation === "unmount") h.view.unmount();
      else if (invalidation === "newer") {
        await act(async () => {
          await write(h, kind, "latest");
        });
      } else if (kind === "Global") {
        vi.mocked(h.bridge.readGlobalPrompt).mockResolvedValue("other-home");
        h.setHome("home-b");
        await waitFor(() => expect(h.current.globalPromptMarkdown).toBe("other-home"));
        if (invalidation === "roundtrip") {
          h.setHome("home-a");
          await waitFor(() => expect(h.current.globalPromptMarkdown).toBe("other-home"));
        }
      } else {
        await act(async () => {
          await h.current.loadProject({
            ...project,
            rootPath: "/tmp/b",
            sourceRoot: "/tmp/b",
            projectId: "P-B"
          });
        });
        if (invalidation === "roundtrip")
          await act(async () => {
            await h.current.loadProject(project);
          });
      }
      const expectedMarkdown =
        kind === "Global" ? h.current.globalPromptMarkdown : h.current.projectPromptMarkdown;
      const expectedPolicy = h.current.projectPromptPolicy;
      h.setError.mockClear();
      await act(async () => {
        pending[outcome]();
        await observed;
      });
      expect(h.setError).not.toHaveBeenCalled();
      if (invalidation !== "unmount") {
        if (kind === "Policy") expect(h.current.projectPromptPolicy).toEqual(expectedPolicy);
        else {
          expect(
            kind === "Global" ? h.current.globalPromptMarkdown : h.current.projectPromptMarkdown
          ).toBe(expectedMarkdown);
          expect(textbox(kind)).toHaveValue(expectedMarkdown ?? "");
        }
      }
    });
  }
}

it.each([
  "Global",
  "Project"
] as const)("old %s finally does not clear a new scope's saving state", async (kind) => {
  const h = await harness();
  const old = pendingWrite(h, kind);
  fireEvent.change(textbox(kind), { target: { value: "old" } });
  save(kind);
  if (kind === "Global") {
    h.setHome("home-b");
    await waitFor(() => expect(h.current.globalPromptMarkdown).toBe("global-base"));
  } else
    await act(async () => {
      await h.current.loadProject({
        ...project,
        rootPath: "/tmp/b",
        sourceRoot: "/tmp/b",
        projectId: "P-B"
      });
    });
  const next = pendingWrite(h, kind);
  fireEvent.change(textbox(kind), { target: { value: "new" } });
  save(kind);
  await act(async () => {
    old.resolve();
  });
  expect(textbox(kind)).toHaveValue("new");
  expect(screen.getByRole("button", { name: `Save ${kind} Prompt` })).toBeDisabled();
  await act(async () => {
    next.resolve();
  });
  expect(screen.getByRole("button", { name: `Save ${kind} Prompt` })).toBeEnabled();
});

it("keeps prompt and policy writes independent within the same project", async () => {
  const h = await harness();
  const pending = pendingWrite(h, "Project");
  let task!: Promise<unknown>;
  act(() => {
    task = h.current.updateProjectPrompt("text");
  });
  await act(async () => {
    await h.current.updateProjectPromptPolicy({ includeGlobalPrompt: false });
  });
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(h.current.projectPromptMarkdown).toBe("stale-body");
  expect(h.current.projectPromptPolicy).toEqual({ includeGlobalPrompt: false });
});

it.each([
  "Project",
  "Policy"
] as const)("reloads %s authority in new Home and discards old write ACK", async (kind) => {
  const h = await harness();
  const pending = pendingWrite(h, kind);
  let task!: Promise<unknown>;
  act(() => {
    task = write(h, kind);
  });
  vi.mocked(h.bridge.getDesktopProjectSnapshot).mockResolvedValueOnce(
    projectSnapshot({
      projectPromptMarkdown: "new-home-project",
      projectPromptPolicy: { includeGlobalPrompt: true }
    })
  );
  await h.selectProjectInHome("home-b");
  expect(h.current.projectPromptMarkdown).toBe("new-home-project");
  await act(async () => {
    pending.resolve();
    await task;
  });
  expect(h.current.projectPromptMarkdown).toBe("new-home-project");
  expect(h.current.projectPromptPolicy).toEqual({ includeGlobalPrompt: true });
  expect(textbox("Project")).toHaveValue("new-home-project");
});

it.each([
  "Project",
  "Policy"
] as const)("ignores old %s failure after Home switch", async (kind) => {
  const h = await harness();
  const pending = pendingWrite(h, kind);
  let task!: Promise<unknown>;
  act(() => {
    task = write(h, kind);
  });
  const observed = task.catch((caught: unknown) => caught);
  await h.selectProjectInHome("home-b");
  expect(h.bridge.getDesktopProjectSnapshot).toHaveBeenCalledTimes(2);
  h.setError.mockClear();
  await act(async () => {
    pending.reject();
    await observed;
  });
  expect(h.setError).not.toHaveBeenCalled();
});

it("saves and reports policy errors through the Settings switch's production hook", async () => {
  const h = await harness();
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Inherit global prompt" }));
  });
  expect(h.bridge.updateProjectPromptPolicy).toHaveBeenCalledWith(project.rootPath, {
    includeGlobalPrompt: false
  });
  expect(screen.getByRole("switch", { name: "Inherit global prompt" })).not.toBeChecked();
  vi.mocked(h.bridge.updateProjectPromptPolicy).mockRejectedValueOnce(new Error("policy failed"));
  await act(async () => {
    fireEvent.click(screen.getByRole("switch", { name: "Inherit global prompt" }));
  });
  expect(h.setError).toHaveBeenCalledWith("policy failed");
  expect(screen.getByRole("switch", { name: "Inherit global prompt" })).not.toBeChecked();
});

it.each([
  "Global",
  "Project"
] as const)("does not publish a pending %s UI save failure after unmount", async (kind) => {
  const h = await harness();
  const pending = pendingWrite(h, kind);
  fireEvent.change(textbox(kind), { target: { value: "pending" } });
  save(kind);
  h.view.unmount();
  h.setError.mockClear();
  await act(async () => {
    pending.reject();
  });
  expect(h.setError).not.toHaveBeenCalled();
});

it.each([
  "resolve",
  "reject"
] as const)("Project Home switch protects new draft/saving from old UI %s", async (outcome) => {
  const h = await harness();
  const old = pendingWrite(h, "Project");
  fireEvent.change(textbox("Project"), { target: { value: "home-A-save" } });
  save("Project");
  vi.mocked(h.bridge.getDesktopProjectSnapshot).mockResolvedValueOnce(
    projectSnapshot({
      projectPromptMarkdown: "home-B-base",
      projectPromptPolicy: { includeGlobalPrompt: true }
    })
  );
  await h.selectProjectInHome("home-b");
  expect(textbox("Project")).toHaveValue("home-B-base");
  const next = pendingWrite(h, "Project");
  fireEvent.change(textbox("Project"), { target: { value: "home-B-draft" } });
  save("Project");
  h.setError.mockClear();
  await act(async () => {
    old[outcome]();
  });
  expect(h.setError).not.toHaveBeenCalled();
  expect(textbox("Project")).toHaveValue("home-B-draft");
  expect(screen.getByRole("button", { name: "Save Project Prompt" })).toBeDisabled();
  await act(async () => {
    next.resolve();
  });
  expect(screen.getByRole("button", { name: "Save Project Prompt" })).toBeEnabled();
});

it.each([
  "Global",
  "Project"
] as const)("retains unconfirmed %s draft when another owner write supersedes UI save, then accepts retry", async (kind) => {
  const h = await harness();
  const old = pendingWrite(h, kind);
  fireEvent.change(textbox(kind), { target: { value: "pending-local" } });
  save(kind);
  await act(async () => {
    await write(h, kind, "newer-authority");
  });
  expect(textbox(kind)).toHaveValue("pending-local");
  await act(async () => {
    old.resolve();
  });
  expect(textbox(kind)).toHaveValue("pending-local");
  await act(async () => {
    save(kind);
  });
  expect(textbox(kind)).toHaveValue("pending-local");
  await act(async () => {
    await write(h, kind, "after-accepted-retry");
  });
  expect(textbox(kind)).toHaveValue("after-accepted-retry");
});
