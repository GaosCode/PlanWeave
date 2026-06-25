import { describe, expect, it } from "vitest";
import {
  findPromptSectionBoundaryIssues,
  formatSection,
  getPromptSection,
  hasUserSection,
  parsePromptSections,
  replacePromptSection
} from "../prompt/sections.js";
import { renderManagedSections } from "../prompt/renderManagedSections.js";

describe("managed prompt sections", () => {
  it("are removed from the v1 source/render split", async () => {
    await expect(renderManagedSections({})).rejects.toThrow("Managed prompt sections were removed");
  });
});

describe("prompt section parsing", () => {
  it("parses well-formed managed and user sections with single edge newline trimming", () => {
    const markdown = [
      "intro",
      "<!-- planweave:managed:start summary -->",
      "",
      "managed body",
      "",
      "<!-- planweave:managed:end summary -->",
      "middle",
      "<!-- planweave:user:start notes -->",
      "user body",
      "<!-- planweave:user:end notes -->",
      "outro"
    ].join("\n");

    expect(parsePromptSections(markdown)).toEqual([
      { kind: "managed", name: "summary", content: "\nmanaged body\n" },
      { kind: "user", name: "notes", content: "user body" }
    ]);
  });

  it("parses multiple sections and preserves helper behavior", () => {
    const first = formatSection("managed", "one", "first");
    const second = formatSection("user", "two", "second\n");
    const markdown = `${first}\n\n${second}`;

    expect(parsePromptSections(markdown)).toEqual([
      { kind: "managed", name: "one", content: "first" },
      { kind: "user", name: "two", content: "second" }
    ]);
    expect(getPromptSection(markdown, "user", "two")).toBe("second");
    expect(hasUserSection(markdown, "two")).toBe(true);
    expect(replacePromptSection(markdown, "managed", "one", "updated")).toContain("updated");
  });

  it("consumes nested markers as outer section content like the previous section matcher", () => {
    const markdown = [
      "<!-- planweave:managed:start outer -->",
      "outer before",
      "<!-- planweave:user:start inner -->",
      "inner body",
      "<!-- planweave:user:end inner -->",
      "outer after",
      "<!-- planweave:managed:end outer -->"
    ].join("\n");

    expect(parsePromptSections(markdown)).toEqual([
      {
        kind: "managed",
        name: "outer",
        content: [
          "outer before",
          "<!-- planweave:user:start inner -->",
          "inner body",
          "<!-- planweave:user:end inner -->",
          "outer after"
        ].join("\n")
      }
    ]);
    expect(getPromptSection(markdown, "user", "inner")).toBeNull();
  });

  it("replaces only the first matching section through the marker scanner", () => {
    const first = formatSection("user", "notes", "first");
    const second = formatSection("user", "notes", "second");
    const markdown = `${first}\n\n${second}`;

    expect(replacePromptSection(markdown, "user", "notes", "updated")).toBe(`${formatSection("user", "notes", "updated")}\n\n${second}`);
  });

  it("throws the existing error when replacing a missing section", () => {
    expect(() => replacePromptSection("plain text", "managed", "missing", "content")).toThrow(
      "Prompt section 'managed:missing' does not exist."
    );
  });

  it("reports mismatched start and end markers", () => {
    const markdown = [
      "<!-- planweave:managed:start alpha -->",
      "body",
      "<!-- planweave:user:end beta -->"
    ].join("\n");

    expect(parsePromptSections(markdown)).toEqual([]);
    expect(findPromptSectionBoundaryIssues(markdown, "prompt.md")).toEqual([
      {
        code: "prompt_section_boundary_invalid",
        message: "Prompt section 'managed:alpha' is closed by mismatched end marker 'user:beta'.",
        path: "prompt.md"
      }
    ]);
  });

  it("scans repeated malformed markers without matching through a section regex", () => {
    const markdown = Array.from({ length: 1000 }, (_, index) => `<!-- planweave:managed:start repeated-${index} -->`).join("\n");

    expect(parsePromptSections(markdown)).toEqual([]);
    expect(findPromptSectionBoundaryIssues(markdown)).toHaveLength(1000);
  });
});
