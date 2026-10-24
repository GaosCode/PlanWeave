import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { normalizedRunnerEventSchema } from "../../runtime/src/autoRun/normalizedEventContract.js";
import { getRunRecord } from "../../runtime/src/desktop/recordsApi.js";
import { acpToolTimelineFixture } from "../src/__tests__/helpers/acpToolTimelineFixture.js";
import { createTaskWorkspaceAcpSmokeFixture } from "../src/__tests__/helpers/taskWorkspaceAcpSmokeFixture.js";

const [action = "create", fixturePath, revision = "streamed"] = process.argv.slice(2);
const safeRevision = revision.replaceAll(/[^a-zA-Z0-9_]/g, "_");
const fixtureSchema = z.object({
  root: z.string(),
  home: z.string(),
  runs: z.array(z.object({ name: z.string(), runId: z.string(), runDir: z.string() }))
});
if (action !== "create" && action !== "update") throw new Error("Expected create or update");
if (action === "update" && !fixturePath) throw new Error("Pass the owned fixture.json path");
const fixture =
  action === "create"
    ? await createTaskWorkspaceAcpSmokeFixture()
    : fixtureSchema.parse(JSON.parse(await readFile(fixturePath!, "utf8")));
process.env.PLANWEAVE_HOME = fixture.home;
for (const run of fixture.runs) {
  const eventFile = join(run.runDir, "events.ndjson");
  const events = (await readFile(eventFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => normalizedRunnerEventSchema.parse(JSON.parse(line)));
  const envelope = events[0];
  if (!envelope) throw new Error("Expected fixture event identity");
  let sequence = action === "create" ? 0 : events.at(-1)!.sequence;
  const tools = acpToolTimelineFixture().map((tool) => {
    if (tool.kind !== "tool") throw new Error("Expected tool fixture");
    const output =
      action === "create"
        ? tool.output!
        : JSON.stringify({
            type: "diff",
            path: `/fixture/tool-${tool.sequence - 1}.ts`,
            oldText: "",
            newText: `export const ${safeRevision}_${tool.sequence} = true;`
          });
    const payload = { content: output, redaction: { classes: [], replaced: 0 } };
    return normalizedRunnerEventSchema.parse({
      ...envelope,
      sequence: ++sequence,
      body:
        action === "create"
          ? {
              kind: "tool_call",
              callId: tool.callId,
              title: tool.title,
              toolKind: tool.toolKind,
              status: tool.status,
              content: null,
              rawInput: { content: tool.input!, redaction: { classes: [], replaced: 0 } },
              rawOutput: payload
            }
          : { kind: "tool_update", callId: tool.callId, rawOutput: payload }
    });
  });
  if (action === "create") {
    const terminal = events.find((event) => event.body.kind === "terminal");
    if (!terminal) throw new Error("Expected completed fixture run");
    await writeFile(
      eventFile,
      `${[...tools, { ...terminal, sequence: ++sequence }]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`
    );
  } else {
    await appendFile(eventFile, `${tools.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  const record = await getRunRecord(fixture.root, `T-001#B-001::${run.runId}`);
  const actualTools = record.runnerReadModel?.timeline.filter((item) => item.kind === "tool");
  if (actualTools?.length !== 200)
    throw new Error(`Expected 200 projected tools, got ${actualTools?.length}`);
  if (action === "update" && !actualTools[0]?.output?.includes(`${safeRevision}_1`))
    throw new Error("Expected the appended tool update in the projected output");
}
process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
