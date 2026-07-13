import type {
  DesktopAgentDetection,
  DesktopAgentKind,
  RunnerTransport
} from "@planweave-ai/runtime";

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
  agentTransport?: RunnerTransport;
  currentExecutorNames?: readonly string[];
  executorOptions: readonly string[];
  literalExecutorNames?: readonly string[];
};

const executorAliases: Record<string, string> = {
  default: "manual",
  "codex-auto": "codex",
  "codex-acp": "codex",
  "claude-code-auto": "claude-code",
  "claude-code-acp": "claude-code",
  "opencode-acp": "opencode",
  "pi-auto": "pi",
  "pi-acp": "pi"
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

export function executorOptionName(
  name: string,
  literalExecutorNames: readonly string[] = []
): string {
  return literalExecutorNames.includes(name) ? name : canonicalExecutorName(name);
}

function optionExecutorName(name: string, literalExecutorNames: ReadonlySet<string>): string {
  return literalExecutorNames.has(name) ? name : canonicalExecutorName(name);
}

function uniqueCanonicalNames(
  names: readonly string[],
  literalExecutorNames: ReadonlySet<string>
): string[] {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const rawName of names) {
    const name = optionExecutorName(rawName, literalExecutorNames);
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    uniqueNames.push(name);
  }
  return uniqueNames;
}

function detectionForName(
  name: string,
  agentDetections: readonly DesktopAgentDetection[],
  agentTransport: RunnerTransport,
  literalExecutorNames: ReadonlySet<string>
) {
  if (literalExecutorNames.has(name)) {
    return null;
  }
  const agentKind = executorAgentKinds[canonicalExecutorName(name)];
  if (!agentKind) {
    return null;
  }
  return (
    agentDetections.find(
      (agent) => agent.kind === agentKind && agent.runnerKind === agentTransport
    ) ?? null
  );
}

function viewForName(
  name: string,
  source: ExecutorOptionView["source"],
  agentDetections: readonly DesktopAgentDetection[],
  agentTransport: RunnerTransport,
  literalExecutorNames: ReadonlySet<string>
): ExecutorOptionView {
  const canonicalName = optionExecutorName(name, literalExecutorNames);
  const detection = detectionForName(
    name,
    agentDetections,
    agentTransport,
    literalExecutorNames
  );
  return {
    name: canonicalName,
    label: canonicalName,
    source,
    detected: detection ? detection.installed : null,
    detectionMessage: detection ? (detection.version ?? detection.unavailableReason) : null,
    disabled: detection?.installed === false
  };
}

export function buildExecutorOptionViews({
  agentDetections = [],
  agentTransport = "cli",
  currentExecutorNames = [],
  executorOptions,
  literalExecutorNames = []
}: ExecutorOptionViewModelInput): ExecutorOptionView[] {
  const literalNameSet = new Set(literalExecutorNames);
  const manifestNames = uniqueCanonicalNames(executorOptions, literalNameSet);
  const manifestNameSet = new Set(manifestNames);
  const currentValueNames = uniqueCanonicalNames(currentExecutorNames, literalNameSet).filter(
    (name) => !manifestNameSet.has(name)
  );

  return [
    ...currentValueNames.map((name) =>
      viewForName(name, "current-value", agentDetections, agentTransport, literalNameSet)
    ),
    ...manifestNames.map((name) =>
      viewForName(name, "manifest", agentDetections, agentTransport, literalNameSet)
    )
  ];
}

export function executorOptionNames(input: ExecutorOptionViewModelInput): string[] {
  return buildExecutorOptionViews(input).map((option) => option.name);
}
