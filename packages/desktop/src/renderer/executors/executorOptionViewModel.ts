import type { DesktopAgentDetection } from "@planweave-ai/runtime";

export type ExecutorOptionView = {
  name: string;
  source: "manifest" | "current-value";
  detected: boolean | null;
  detectionMessage: string | null;
};

type ExecutorOptionViewModelInput = {
  agentDetections?: DesktopAgentDetection[];
  currentExecutorNames?: readonly string[];
  executorOptions: readonly string[];
};

function detectionForName(name: string, agentDetections: readonly DesktopAgentDetection[]) {
  return agentDetections.find((agent) => agent.kind === name) ?? null;
}

function viewForName(name: string, source: ExecutorOptionView["source"], agentDetections: readonly DesktopAgentDetection[]): ExecutorOptionView {
  const detection = detectionForName(name, agentDetections);
  return {
    name,
    source,
    detected: detection ? detection.installed : null,
    detectionMessage: detection ? detection.version ?? detection.unavailableReason : null
  };
}

export function buildExecutorOptionViews({
  agentDetections = [],
  currentExecutorNames = [],
  executorOptions
}: ExecutorOptionViewModelInput): ExecutorOptionView[] {
  const manifestNames = [...new Set(executorOptions)];
  const manifestNameSet = new Set(manifestNames);
  const currentValueNames = [...new Set(currentExecutorNames)].filter((name) => !manifestNameSet.has(name));

  return [
    ...currentValueNames.map((name) => viewForName(name, "current-value", agentDetections)),
    ...manifestNames.map((name) => viewForName(name, "manifest", agentDetections))
  ];
}

export function executorOptionNames(input: ExecutorOptionViewModelInput): string[] {
  return buildExecutorOptionViews(input).map((option) => option.name);
}
