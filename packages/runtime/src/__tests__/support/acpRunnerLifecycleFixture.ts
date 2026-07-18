import { fileURLToPath } from "node:url";
import { codexAgentDefinition } from "../../autoRun/codexIntegration.js";

const fixture = fileURLToPath(new URL("./acpMockAgent.mjs", import.meta.url));

function mockLaunch(scenario: string) {
  const source = codexAgentDefinition.acp.launch?.source;
  if (!source) throw new Error("Expected Codex ACP launch source metadata.");
  return { command: process.execPath, args: [fixture, scenario], source };
}

export { fixture, mockLaunch };
