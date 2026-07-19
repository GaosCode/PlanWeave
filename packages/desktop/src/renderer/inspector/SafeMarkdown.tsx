import { createElement, Fragment, type ReactNode } from "react";

function inlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  let offset = 0;
  return parts.filter(Boolean).map((part) => {
    const partOffset = offset;
    offset += part.length;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]" key={partOffset}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={partOffset}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={partOffset}>{part}</Fragment>;
  });
}

type TableCell = { offset: number; text: string };

function tableRow(line: string): TableCell[] {
  const content = line.trim().replace(/^\||\|$/g, "");
  let offset = 0;
  return content.split("|").map((cell) => {
    const result = { offset, text: cell.trim() };
    offset += cell.length + 1;
    return result;
  });
}

export function SafeMarkdown({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push(
        <div
          className="overflow-hidden rounded-lg border bg-slate-950 text-slate-50"
          key={`code-${index}`}
        >
          {language ? (
            <div className="border-b border-white/10 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-400">
              {language}
            </div>
          ) : null}
          <pre className="overflow-x-auto p-3 text-xs leading-5">
            <code>{code.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const className = level === 1 ? "text-lg" : level === 2 ? "text-base" : "text-sm";
      const tag = level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "h4";
      blocks.push(
        createElement(
          tag,
          { className: `${className} font-semibold leading-tight`, key: `heading-${index}` },
          inlineMarkdown(heading[2] ?? "")
        )
      );
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const ordered = /^\d+\.\s+/.test(line);
      const items: Array<{ lineNumber: number; text: string }> = [];
      while (
        index < lines.length &&
        (ordered ? /^\d+\.\s+/.test(lines[index] ?? "") : /^[-*]\s+/.test(lines[index] ?? ""))
      ) {
        items.push({
          lineNumber: index,
          text: (lines[index] ?? "").replace(ordered ? /^\d+\.\s+/ : /^[-*]\s+/, "")
        });
        index += 1;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List
          className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5`}
          key={`list-${index}`}
        >
          {items.map((item) => (
            <li key={item.lineNumber}>{inlineMarkdown(item.text)}</li>
          ))}
        </List>
      );
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-+/.test(lines[index + 1] ?? "")) {
      const headerLineNumber = index;
      const headers = tableRow(line);
      index += 2;
      const rows: Array<{ cells: TableCell[]; lineNumber: number }> = [];
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push({ cells: tableRow(lines[index] ?? ""), lineNumber: index });
        index += 1;
      }
      blocks.push(
        <div className="overflow-x-auto rounded-lg border" key={`table-${index}`}>
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-muted/70">
              <tr>
                {headers.map((header) => (
                  <th
                    className="border-b px-3 py-2 font-medium"
                    key={`${headerLineNumber}:${header.offset}`}
                  >
                    {inlineMarkdown(header.text)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-b last:border-0" key={row.lineNumber}>
                  {row.cells.map((cell) => (
                    <td className="px-3 py-2 align-top" key={`${row.lineNumber}:${cell.offset}`}>
                      {inlineMarkdown(cell.text)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^(#{1,4})\s+|^```|^[-*]\s+|^\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(
      <p className="whitespace-pre-wrap break-words leading-6" key={`paragraph-${index}`}>
        {inlineMarkdown(paragraph.join("\n"))}
      </p>
    );
  }

  return <div className="space-y-3">{blocks}</div>;
}
