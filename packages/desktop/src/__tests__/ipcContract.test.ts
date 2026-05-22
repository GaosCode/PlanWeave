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
    const [runtimeBridgeSource, packageWatchSource, preloadSource] = await Promise.all([
      readDesktopSource("main/runtimeBridgeHandlers.ts"),
      readDesktopSource("main/packageWatch.ts"),
      readDesktopSource("preload/preload.ts")
    ]);

    const handledChannels = new Set(channelsFor(`${runtimeBridgeSource}\n${packageWatchSource}`, /ipcMain\.handle\("([^"]+)"/g));
    const invokedChannels = channelsFor(preloadSource, /ipcRenderer\.invoke\("([^"]+)"/g);

    expect(invokedChannels).not.toHaveLength(0);
    expect(invokedChannels.filter((channel) => !handledChannels.has(channel))).toEqual([]);
  });

  it("keeps package file change events registered on both sides", async () => {
    const [packageWatchSource, preloadSource] = await Promise.all([
      readDesktopSource("main/packageWatch.ts"),
      readDesktopSource("preload/preload.ts")
    ]);

    expect(packageWatchSource).toContain('const packageFileChangedChannel = "planweave:packageFileChanged"');
    expect(preloadSource).toContain('const packageFileChangedChannel = "planweave:packageFileChanged"');
    expect(packageWatchSource).toContain("webContents.send(packageFileChangedChannel");
    expect(preloadSource).toContain("ipcRenderer.on(packageFileChangedChannel");
  });

  it("watches package files from the runtime workspace instead of the project root", async () => {
    const packageWatchSource = await readDesktopSource("main/packageWatch.ts");

    expect(packageWatchSource).toContain("const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId)");
    expect(packageWatchSource).toContain("watchRoot(workspace.workspaceRoot, workspace.packageDir");
    expect(packageWatchSource).toContain("dirname(workspace.projectPromptFile)");
    expect(packageWatchSource).not.toContain('watchRoot(projectRoot, join(projectRoot, "package")');
  });

  it("strips compiled graph internals from graph edit IPC results", async () => {
    const runtimeBridgeSource = await readDesktopSource("main/runtimeBridgeHandlers.ts");

    expect(runtimeBridgeSource).toContain("function cloneableGraphEditResult(result: GraphEditResult): DesktopGraphEditResult");
    expect(runtimeBridgeSource).toContain("const { graph: _graph, ...cloneable } = result");
    expect(runtimeBridgeSource).toContain('ipcMain.handle("planweave:addTaskNode"');
    expect(runtimeBridgeSource).toContain("invokeGraphEdit(addTaskNode(await canvasWorkspace(projectRoot, canvasId), input))");
    expect(runtimeBridgeSource).toContain("invokeGraphEdit(updateTaskPrompt(await canvasWorkspace(projectRoot, canvasId), taskId, markdown))");
  });
});
