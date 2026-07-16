import type { ReactNode } from "react";

export type AcpToolFileDiff = {
  newStartLine: number;
  newText: string;
  oldStartLine: number;
  oldText: string;
  path: string;
};

type DiffRow = {
  kind: "addition" | "context" | "deletion";
  newLine: number | null;
  oldLine: number | null;
  text: string;
};

type DiffOperation = { kind: DiffRow["kind"]; text: string };

const keywordPattern = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield"
]);

function positiveLine(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

export function parseAcpToolDiff(value: string | null): AcpToolFileDiff[] | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const diffs: AcpToolFileDiff[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (
      record.type !== "diff" ||
      typeof record.path !== "string" ||
      typeof record.newText !== "string"
    ) {
      continue;
    }
    const oldText = record.oldText;
    if (oldText !== undefined && oldText !== null && typeof oldText !== "string") continue;
    const metadata =
      record._meta && typeof record._meta === "object" && !Array.isArray(record._meta)
        ? (record._meta as Record<string, unknown>)
        : {};
    diffs.push({
      path: record.path,
      oldText: oldText ?? "",
      newText: record.newText,
      oldStartLine: positiveLine(metadata.old_line),
      newStartLine: positiveLine(metadata.new_line)
    });
  }
  return diffs.length > 0 ? diffs : null;
}

function lines(value: string): string[] {
  if (value === "") return [];
  const result = value.replaceAll("\r\n", "\n").split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function boundedLineDiff(oldLines: string[], newLines: string[]): DiffOperation[] {
  if (oldLines.length === 0) return newLines.map((text) => ({ kind: "addition", text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ kind: "deletion", text }));
  if (oldLines.length * newLines.length > 120_000) {
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
    ) {
      suffix += 1;
    }
    return [
      ...oldLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
      ...oldLines
        .slice(prefix, oldLines.length - suffix)
        .map((text) => ({ kind: "deletion" as const, text })),
      ...newLines
        .slice(prefix, newLines.length - suffix)
        .map((text) => ({ kind: "addition" as const, text })),
      ...oldLines
        .slice(oldLines.length - suffix)
        .map((text) => ({ kind: "context" as const, text }))
    ];
  }

  const table = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1)
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }
  const result: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      result.push({ kind: "context", text: oldLines[oldIndex]! });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < newLines.length &&
      (oldIndex === oldLines.length ||
        table[oldIndex]![newIndex + 1]! >= table[oldIndex + 1]![newIndex]!)
    ) {
      result.push({ kind: "addition", text: newLines[newIndex]! });
      newIndex += 1;
    } else {
      result.push({ kind: "deletion", text: oldLines[oldIndex]! });
      oldIndex += 1;
    }
  }
  return result;
}

function diffRows(diff: AcpToolFileDiff): DiffRow[] {
  let oldLine = diff.oldStartLine;
  let newLine = diff.newStartLine;
  return boundedLineDiff(lines(diff.oldText), lines(diff.newText)).map((operation) => {
    const row: DiffRow = {
      ...operation,
      oldLine: operation.kind === "addition" ? null : oldLine,
      newLine: operation.kind === "deletion" ? null : newLine
    };
    if (operation.kind !== "addition") oldLine += 1;
    if (operation.kind !== "deletion") newLine += 1;
    return row;
  });
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function highlightedLine(text: string): ReactNode[] {
  const tokens = text.split(
    /(\/\/.*$|#[^"'`]*$|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
  );
  return tokens.filter(Boolean).map((token, index) => {
    let className = "";
    if (token.startsWith("//") || token.startsWith("/*") || token.startsWith("#")) {
      className = "text-text-muted italic";
    } else if (/^["'`]/.test(token)) {
      className = "text-amber-700 dark:text-amber-300";
    } else if (/^\d/.test(token)) {
      className = "text-cyan-700 dark:text-cyan-300";
    } else if (keywordPattern.has(token)) {
      className = "font-medium text-violet-700 dark:text-violet-300";
    } else if (/^[A-Z]/.test(token)) {
      className = "text-sky-700 dark:text-sky-300";
    }
    return className ? (
      <span className={className} key={index}>
        {token}
      </span>
    ) : (
      token
    );
  });
}

export function AcpToolDiff({ diffs }: { diffs: readonly AcpToolFileDiff[] }) {
  return (
    <div className="space-y-3" data-testid="acp-tool-diff">
      {diffs.map((diff, diffIndex) => {
        const rows = diffRows(diff);
        const additions = rows.filter((row) => row.kind === "addition").length;
        const deletions = rows.filter((row) => row.kind === "deletion").length;
        return (
          <section
            className="overflow-hidden rounded-lg border border-border/80 bg-app-canvas"
            key={`${diff.path}-${diffIndex}`}
          >
            <header className="flex items-center gap-2 border-b border-border/80 bg-surface-muted/60 px-3 py-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium"
                title={diff.path}
              >
                {fileName(diff.path)}
              </span>
              <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
                +{additions}
              </span>
              <span className="font-mono text-[11px] text-red-600 dark:text-red-400">
                -{deletions}
              </span>
            </header>
            <div className="max-h-96 overflow-auto [scrollbar-gutter:stable]">
              <div className="min-w-max font-mono text-[11px] leading-5">
                {rows.map((row, rowIndex) => (
                  <div
                    className={
                      row.kind === "addition"
                        ? "grid grid-cols-[3.25rem_3.25rem_1.5rem_minmax(0,1fr)] bg-emerald-500/10"
                        : row.kind === "deletion"
                          ? "grid grid-cols-[3.25rem_3.25rem_1.5rem_minmax(0,1fr)] bg-red-500/10"
                          : "grid grid-cols-[3.25rem_3.25rem_1.5rem_minmax(0,1fr)]"
                    }
                    data-diff-line={row.kind}
                    key={rowIndex}
                  >
                    <span className="select-none border-r border-border/60 px-2 text-right tabular-nums text-text-muted/70">
                      {row.oldLine ?? ""}
                    </span>
                    <span className="select-none border-r border-border/60 px-2 text-right tabular-nums text-text-muted/70">
                      {row.newLine ?? ""}
                    </span>
                    <span
                      className={
                        row.kind === "addition"
                          ? "select-none text-center text-emerald-600 dark:text-emerald-400"
                          : row.kind === "deletion"
                            ? "select-none text-center text-red-600 dark:text-red-400"
                            : "select-none text-center text-text-muted/40"
                      }
                    >
                      {row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : " "}
                    </span>
                    <code className="whitespace-pre px-2 pr-4">{highlightedLine(row.text)}</code>
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
