import type { AcpTimelineItem } from "@planweave-ai/runtime";

export function acpToolTimelineFixture(count = 200, lineCount = 200): AcpTimelineItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "tool",
    sequence: index + 1,
    timestamp: "2026-07-13T00:00:00.000Z",
    callId: `lazy-tool-${index}`,
    title: `Edit fixture ${index}`,
    status: "completed",
    toolKind: "edit",
    input: JSON.stringify({ text: `unique input ${index}` }),
    output: JSON.stringify({
      type: "diff",
      path: `/fixture/tool-${index}.ts`,
      oldText: "",
      newText: Array.from(
        { length: lineCount },
        (_, line) => `export const fixture_${index}_${line} = "unique body ${index}:${line}";`
      ).join("\n")
    })
  }));
}
