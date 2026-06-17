import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("desktop renderer workflow guardrails", () => {
  it("keeps the Electron smoke on real renderer interactions without test-only IPC or text selectors", async () => {
    const [mainSource, smokeSource] = await Promise.all([
      readFile(resolve(sourceDir, "main", "main.ts"), "utf8"),
      readFile(resolve(sourceDir, "main", "smoke.ts"), "utf8")
    ]);

    expect(smokeSource).toContain("async function runRendererManualSmoke");
    expect(smokeSource).toContain("const clickByTestId = async");
    expect(smokeSource).toContain('await clickByTestId("sidebar-new-task")');
    expect(smokeSource).toContain('await clickByTestId("new-task-generate-draft")');
    expect(smokeSource).toContain('await clickByTestId("new-task-confirm-write")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-statistics")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-search")');
    expect(smokeSource).toContain('await clickByTestId("sidebar-settings")');
    expect(smokeSource).toContain('await waitForSelector("[data-auto-run-control]", "Floating Auto Run control")');
    expect(smokeSource).toContain('await clickByTestId("auto-run-trigger")');
    expect(smokeSource).toContain('await waitForSelector(\'[data-testid="auto-run-mini-panel"]\', "mini Auto Run panel")');
    expect(smokeSource).toContain('await clickByTestId("auto-run-open-record")');
    expect(smokeSource).toContain('recordActionPath.endsWith("metadata.json")');
    expect(smokeSource).toContain("recordRunId !== statusRunId");
    expect(smokeSource).toContain("!statusRunId || !recordRunId");
    expect(smokeSource).toContain("window.planweaveSmoke.clearLastRevealPath()");
    expect(smokeSource).toContain("await waitForSmokeRevealPath(recordActionPath)");
    expect(smokeSource).not.toContain('await clickByText("新建任务画布")');
    expect(smokeSource).not.toContain('await clickByText("生成 Draft")');
    expect(smokeSource).not.toContain('await clickByText("确认写入")');
    expect(smokeSource).not.toContain('await clickByText("统计")');
    expect(smokeSource).not.toContain('await clickByText("搜索")');
    expect(smokeSource).not.toContain('await clickByText("设置")');
    expect(smokeSource).not.toContain('await waitForText("运行面板")');
    expect(smokeSource).not.toContain('await waitForText("当前 Block")');
    expect(smokeSource).not.toContain("planweave:rendererSmoke");
    expect(mainSource).toContain("delete process.env.PLANWEAVE_HOME");
    expect(mainSource).toContain('app.setPath("userData", process.env.PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR)');
  });
});
