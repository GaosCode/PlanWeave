import type { ValidationIssue } from "../types.js";

export type PromptSectionKind = "managed" | "user";

export type PromptSection = {
  kind: PromptSectionKind;
  name: string;
  content: string;
};

const markerPattern = /<!-- planweave:(managed|user):(start|end) ([a-z0-9-]+) -->/g;

type PromptSectionMarker = {
  kind: PromptSectionKind;
  boundary: "start" | "end";
  name: string;
  startIndex: number;
  endIndex: number;
};

type PromptSectionRange = PromptSection & {
  markerStartIndex: number;
  markerEndIndex: number;
};

function scanPromptSectionMarkers(markdown: string): PromptSectionMarker[] {
  return [...markdown.matchAll(markerPattern)].map((match) => ({
    kind: match[1] as PromptSectionKind,
    boundary: match[2] as "start" | "end",
    name: match[3],
    startIndex: match.index,
    endIndex: match.index + match[0].length
  }));
}

function markerKey(marker: Pick<PromptSectionMarker, "kind" | "name">): string {
  return `${marker.kind}:${marker.name}`;
}

function findPromptSectionRanges(markdown: string): PromptSectionRange[] {
  const markers = scanPromptSectionMarkers(markdown);
  const nextEndByKey = new Map<string, number>();
  const matchingEndByStart = new Map<number, number>();

  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    const key = markerKey(marker);

    if (marker.boundary === "end") {
      nextEndByKey.set(key, index);
      continue;
    }

    const endIndex = nextEndByKey.get(key);
    if (endIndex !== undefined) {
      matchingEndByStart.set(index, endIndex);
    }
  }

  const sections: PromptSectionRange[] = [];
  let index = 0;
  while (index < markers.length) {
    const marker = markers[index];
    const endIndex = marker.boundary === "start" ? matchingEndByStart.get(index) : undefined;

    if (endIndex === undefined) {
      index += 1;
      continue;
    }

    const endMarker = markers[endIndex];
    sections.push({
      kind: marker.kind,
      name: marker.name,
      content: markdown.slice(marker.endIndex, endMarker.startIndex).replace(/^\n/, "").replace(/\n$/, ""),
      markerStartIndex: marker.startIndex,
      markerEndIndex: endMarker.endIndex
    });
    index = endIndex + 1;
  }

  return sections;
}

function sectionIssue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

export function findPromptSectionBoundaryIssues(markdown: string, path?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stack: Array<{ kind: PromptSectionKind; name: string }> = [];

  for (const marker of scanPromptSectionMarkers(markdown)) {
    const { kind, name } = marker;

    if (marker.boundary === "start") {
      stack.push({ kind, name });
      continue;
    }

    const open = stack.pop();
    if (!open) {
      issues.push(sectionIssue("prompt_section_boundary_invalid", `Prompt section '${kind}:${name}' has an end marker without a start marker.`, path));
      continue;
    }
    if (open.kind !== kind || open.name !== name) {
      issues.push(
        sectionIssue(
          "prompt_section_boundary_invalid",
          `Prompt section '${open.kind}:${open.name}' is closed by mismatched end marker '${kind}:${name}'.`,
          path
        )
      );
    }
  }

  for (const open of stack) {
    issues.push(
      sectionIssue("prompt_section_boundary_invalid", `Prompt section '${open.kind}:${open.name}' has a start marker without an end marker.`, path)
    );
  }

  return issues;
}

export function assertPromptSectionsWellFormed(markdown: string, path?: string): void {
  const issues = findPromptSectionBoundaryIssues(markdown, path);
  if (issues.length > 0) {
    throw new Error(`${issues[0].code}: ${issues[0].message}`);
  }
}

export function parsePromptSections(markdown: string): PromptSection[] {
  return findPromptSectionRanges(markdown).map(({ kind, name, content }) => ({ kind, name, content }));
}

export function getPromptSection(markdown: string, kind: PromptSectionKind, name: string): string | null {
  const section = parsePromptSections(markdown).find((item) => item.kind === kind && item.name === name);
  return section?.content ?? null;
}

export function hasUserSection(markdown: string, name: string): boolean {
  return getPromptSection(markdown, "user", name) !== null;
}

export function formatSection(kind: PromptSectionKind, name: string, content: string): string {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return `<!-- planweave:${kind}:start ${name} -->\n${body}\n<!-- planweave:${kind}:end ${name} -->`;
}

export function replacePromptSection(markdown: string, kind: PromptSectionKind, name: string, content: string): string {
  const section = findPromptSectionRanges(markdown).find((item) => item.kind === kind && item.name === name);
  if (!section) {
    throw new Error(`Prompt section '${kind}:${name}' does not exist.`);
  }
  return `${markdown.slice(0, section.markerStartIndex)}${formatSection(kind, name, content)}${markdown.slice(section.markerEndIndex)}`;
}
