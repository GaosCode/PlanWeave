import type { DesktopAgentDetection, DesktopAgentKind } from "@planweave-ai/runtime";

export type ExecutorOptionView = {
  name: string;
  label: string;
  source: "manifest" | "current-value";
  detected: boolean | null;
  detectionMessage: string | null;
  disabled: boolean;
};

type ExecutorOptionViewModelInput = {
  agentDetections?: DesktopAgentDetection[];
  currentExecutorNames?: readonly string[];
  executorOptions: readonly string[];
};

const executorAliases: Record<string, string> = {
  default: "manual",
  "codex-auto": "codex",
  "claude-code-auto": "claude-code",
  "pi-auto": "pi"
};

const executorAgentKinds: Record<string, DesktopAgentKind> = {
  codex: "codex",
  opencode: "opencode",
  "claude-code": "claude-code",
  pi: "pi"
};

export function canonicalExecutorName(name: string): string {
  return executorAliases[name] ?? name;
}

function uniqueCanonicalNames(names: readonly string[]): string[] {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = canonicalExecutorName(rawName);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    uniqueNames.push(name);
  }
  return uniqueNames;
}

function detectionForName(name: string, agentDetections: readonly DesktopAgentDetection[]) {
  const agentKind = executorAgentKinds[canonicalExecutorName(name)];
  if (!agentKind) {
    return null;
  }
  return agentDetections.find((agent) => agent.kind === agentKind) ?? null;
}

function viewForName(name: string, source: ExecutorOptionView["source"], agentDetections: readonly DesktopAgentDetection[]): ExecutorOptionView {
  const canonicalName = canonicalExecutorName(name);
  const detection = detectionForName(name, agentDetections);
  return {
    name: canonicalName,
    label: canonicalName,
    source,
    detected: detection ? detection.installed : null,
    detectionMessage: detection ? detection.version ?? detection.unavailableReason : null,
    disabled: detection?.installed === false
  };
}

export function buildExecutorOptionViews({
  agentDetections = [],
  currentExecutorNames = [],
  executorOptions
}: ExecutorOptionViewModelInput): ExecutorOptionView[] {
  const manifestNames = uniqueCanonicalNames(executorOptions);
  const manifestNameSet = new Set(manifestNames);
  const currentValueNames = uniqueCanonicalNames(currentExecutorNames).filter((name) => !manifestNameSet.has(name));

  return [
    ...currentValueNames.map((name) => viewForName(name, "current-value", agentDetections)),
    ...manifestNames.map((name) => viewForName(name, "manifest", agentDetections))
  ];
}

export function executorOptionNames(input: ExecutorOptionViewModelInput): string[] {
  return buildExecutorOptionViews(input).map((option) => option.name);
}
