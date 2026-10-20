import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTaskWorkspaceAcpSmokeFixture,
  readTaskWorkspaceAcpSmokeControls,
  pauseTaskWorkspaceAcpFixture,
  releaseTaskWorkspaceAcpFixture,
  waitForTaskWorkspaceAcpBarrier
} from "../packages/desktop/src/__tests__/helpers/taskWorkspaceAcpSmokeFixture.js";

const [action = "create", fixtureFile, runName = "a"] = process.argv.slice(2);
if (action === "create") {
  const fixture = await createTaskWorkspaceAcpSmokeFixture();
  process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
} else {
  if (!fixtureFile) throw new Error("Pass the owned fixture.json path and run name a/b.");
  const fixture = await readTaskWorkspaceAcpSmokeControls(fixtureFile);
  const run = fixture.runs.find((item) => item.name === runName);
  if (!run) throw new Error(`Unknown fixture run: ${runName}`);
  if (action === "pause") await pauseTaskWorkspaceAcpFixture(run.controlDir);
  else if (action === "wait") await waitForTaskWorkspaceAcpBarrier(run.controlDir);
  else if (action === "release") await releaseTaskWorkspaceAcpFixture(run.controlDir);
  else if (action === "fail") await writeFile(join(run.controlDir, "force-exit"), "42\n");
  else throw new Error("Expected create, pause, wait, release, or fail.");
  process.stdout.write(`${action} ${runName}: done\n`);
}
