import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readDesktopSource(path: string): Promise<string> {
  return readFile(resolve(desktopSrc, path), "utf8");
}

function channelsFor(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

describe("desktop IPC contract", () => {
  it("keeps preload invoke channels backed by main handlers", async () => {
    const [mainSource, preloadSource] = await Promise.all([
      readDesktopSource("main/main.ts"),
      readDesktopSource("preload/preload.ts")
    ]);

    const handledChannels = new Set(channelsFor(mainSource, /ipcMain\.handle\("([^"]+)"/g));
    const invokedChannels = channelsFor(preloadSource, /ipcRenderer\.invoke\("([^"]+)"/g);

    expect(invokedChannels).not.toHaveLength(0);
    expect(invokedChannels.filter((channel) => !handledChannels.has(channel))).toEqual([]);
  });

  it("keeps package file change events registered on both sides", async () => {
    const [mainSource, preloadSource] = await Promise.all([
      readDesktopSource("main/main.ts"),
      readDesktopSource("preload/preload.ts")
    ]);

    expect(mainSource).toContain('const packageFileChangedChannel = "planweave:packageFileChanged"');
    expect(preloadSource).toContain('const packageFileChangedChannel = "planweave:packageFileChanged"');
    expect(mainSource).toContain("webContents.send(packageFileChangedChannel");
    expect(preloadSource).toContain("ipcRenderer.on(packageFileChangedChannel");
  });

  it("watches package files from the runtime workspace instead of the project root", async () => {
    const mainSource = await readDesktopSource("main/main.ts");

    expect(mainSource).toContain("const workspace = await resolveProjectWorkspace(projectRoot)");
    expect(mainSource).toContain("watchRoot(workspace.workspaceRoot, workspace.packageDir");
    expect(mainSource).toContain("dirname(workspace.projectPromptFile)");
    expect(mainSource).not.toContain('watchRoot(projectRoot, join(projectRoot, "package")');
  });

  it("strips compiled graph internals from graph edit IPC results", async () => {
    const mainSource = await readDesktopSource("main/main.ts");

    expect(mainSource).toContain("function cloneableGraphEditResult(result: GraphEditResult): DesktopGraphEditResult");
    expect(mainSource).toContain("const { graph: _graph, ...cloneable } = result");
    expect(mainSource).toContain('ipcMain.handle("planweave:addTaskNode"');
    expect(mainSource).toContain("invokeGraphEdit(addTaskNode(projectRoot, input))");
    expect(mainSource).toContain("invokeGraphEdit(updateTaskPrompt(projectRoot, taskId, markdown))");
  });
});
