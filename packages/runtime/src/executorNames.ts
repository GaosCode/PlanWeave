export const builtinExecutorNames = [
  "default",
  "manual",
  "codex",
  "codex-auto",
  "codex-acp",
  "opencode",
  "opencode-acp",
  "claude-code",
  "claude-code-auto",
  "claude-code-acp",
  "pi",
  "pi-auto",
  "pi-acp",
  "grok",
  "grok-acp"
] as const;

const builtinExecutorNameSet = new Set<string>(builtinExecutorNames);

const builtinExecutorAliases: Readonly<Record<string, string>> = {
  default: "manual",
  "codex-auto": "codex",
  "codex-acp": "codex",
  "claude-code-auto": "claude-code",
  "claude-code-acp": "claude-code",
  "opencode-acp": "opencode",
  "pi-auto": "pi",
  "pi-acp": "pi",
  "grok-acp": "grok"
};

export function canonicalBuiltinExecutorName(name: string): string {
  return builtinExecutorAliases[name] ?? name;
}

export function isBuiltinExecutorName(name: string): boolean {
  return builtinExecutorNameSet.has(name);
}
