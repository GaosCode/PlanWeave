import { opencodeReport, parseOpencodeJsonOutput } from "../autoRun/opencodeOutput.js";
import type { ExecutorIntegrationName } from "../types.js";
import type { DesktopRunRecord } from "./types.js";

export function cleanOutputSummary(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim()
    .slice(0, 400);
}

export function outputSummaryForRecord(
  adapter: ExecutorIntegrationName | null,
  stdout: string,
  stderr: string
): string {
  if (adapter === "opencode-exec") {
    const parsed = parseOpencodeJsonOutput(stdout);
    const report = opencodeReport(parsed, "", "");
    if (report) {
      return cleanOutputSummary(report);
    }
  }
  return cleanOutputSummary(stdout || stderr);
}

function liveOutputMarkdown(
  adapter: ExecutorIntegrationName | null,
  stdout: string,
  stderr: string
): string {
  if (adapter === "opencode-exec") {
    return opencodeReport(parseOpencodeJsonOutput(stdout), "", stderr).trim();
  }
  return cleanOutputSummary(stdout || stderr);
}

export function displayMarkdownForRecord(options: {
  adapter: ExecutorIntegrationName | null;
  reportMarkdown: string;
  stdout: string;
  stderr: string;
}): { displayMarkdown: string; displayMarkdownSource: DesktopRunRecord["displayMarkdownSource"] } {
  if (options.reportMarkdown) {
    return { displayMarkdown: options.reportMarkdown, displayMarkdownSource: "report" };
  }
  const liveMarkdown = liveOutputMarkdown(options.adapter, options.stdout, options.stderr);
  return liveMarkdown
    ? { displayMarkdown: liveMarkdown, displayMarkdownSource: "live-output" }
    : { displayMarkdown: "", displayMarkdownSource: "none" };
}
