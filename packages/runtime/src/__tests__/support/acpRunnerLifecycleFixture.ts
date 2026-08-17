import { fileURLToPath } from "node:url";
import { createAcpRunner } from "../../autoRun/acpRunner.js";
import { codexAgentDefinition } from "../../autoRun/codexIntegration.js";
import { acpProfileResolverTestDouble } from "./acpProfileTestValues.js";

const fixture = fileURLToPath(new URL("./acpMockAgent.mjs", import.meta.url));

function mockLaunch(scenario: string) {
  const source = codexAgentDefinition.acp.launch?.source;
  if (!source) throw new Error("Expected Codex ACP launch source metadata.");
  return { command: process.execPath, args: [fixture, scenario], source };
}

function createMockAcpRunner(
  scenario: string,
  options: Omit<NonNullable<Parameters<typeof createAcpRunner>[0]>, "profileResolver"> = {}
) {
  return createAcpRunner({
    ...options,
    profileResolver: acpProfileResolverTestDouble({
      launch: mockLaunch(scenario)
    })
  });
}

export { createMockAcpRunner, fixture, mockLaunch };
