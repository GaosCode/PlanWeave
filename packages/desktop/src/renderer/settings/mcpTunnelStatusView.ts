import type { McpTunnelPhase } from "../../shared/mcpTunnel";
import type { createTranslator } from "../i18n";

export function phaseVariant(
  phase: McpTunnelPhase
): "default" | "secondary" | "destructive" | "outline" {
  if (phase === "running") {
    return "default";
  }
  if (phase === "error") {
    return "destructive";
  }
  if (phase === "starting" || phase === "stopping") {
    return "secondary";
  }
  return "outline";
}

export function tunnelStatusLabel(
  status: { phase: McpTunnelPhase; ready: boolean },
  t: ReturnType<typeof createTranslator>
): string {
  return status.phase === "running" && status.ready ? t("mcpTunnelReadyStatus") : status.phase;
}
