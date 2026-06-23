import { describe, expect, it } from "vitest";
import {
  createDesktopSearchDocument,
  searchDesktopSearchIndex,
  type DesktopSearchDocument,
  type DesktopSearchDocumentInput,
  type DesktopSearchIndex
} from "../desktop/graph/searchIndexModel.js";
import type { DesktopSearchResultKind } from "../desktop/types.js";

function searchIndex(documents: DesktopSearchDocument[]): DesktopSearchIndex {
  return {
    documents,
    diagnostics: []
  };
}

function searchDocument(overrides: Partial<DesktopSearchDocumentInput> & { ref: string }): DesktopSearchDocument {
  return createDesktopSearchDocument({
    kind: "task",
    canvasId: "default",
    canvasName: "Default",
    title: "Search document",
    body: "",
    ...overrides
  });
}

function matchingDocuments(count: number): DesktopSearchDocument[] {
  return Array.from({ length: count }, (_, index) => searchDocument({
    ref: `T-${String(index).padStart(3, "0")}`,
    title: `Limit match ${index}`,
    body: "limit needle"
  }));
}

describe("desktop search index model", () => {
  it("ranks exact title matches ahead of title includes and body-only matches", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({ ref: "body", title: "Body only", body: "rank needle" }),
      searchDocument({ ref: "title-includes", title: "Implement rank needle", body: "" }),
      searchDocument({ ref: "title-exact", title: "rank needle", body: "" })
    ]), "rank needle");

    expect(results.map((result) => result.ref)).toEqual(["title-exact", "title-includes", "body"]);
  });

  it("ranks title includes ahead of body includes", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({ ref: "body-first", title: "Body first", body: "title priority needle" }),
      searchDocument({ ref: "title-second", title: "Title priority needle", body: "" })
    ]), "priority needle");

    expect(results.map((result) => result.ref)).toEqual(["title-second", "body-first"]);
  });

  it("ranks prompt task block and feedback matches ahead of historical result body matches", () => {
    const documents: DesktopSearchDocument[] = [
      searchDocument({ kind: "run_record", ref: "run", title: "Run record", body: "kind priority needle" }),
      searchDocument({ kind: "review_attempt", ref: "review", title: "Review attempt", body: "kind priority needle" }),
      searchDocument({ kind: "feedback", ref: "feedback", title: "Feedback", body: "kind priority needle" }),
      searchDocument({ kind: "block", ref: "block", title: "Block", body: "kind priority needle" }),
      searchDocument({ kind: "task", ref: "task", title: "Task", body: "kind priority needle" }),
      searchDocument({ kind: "prompt", ref: "prompt", title: "Prompt", body: "kind priority needle" })
    ];

    const results = searchDesktopSearchIndex(searchIndex(documents), "priority needle");

    expect(results.map((result) => result.ref)).toEqual(["feedback", "block", "task", "prompt", "run", "review"]);
  });

  it("uses original document order as the final stable tie breaker", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({ ref: "first", title: "First", body: "stable order needle" }),
      searchDocument({ ref: "second", title: "Second", body: "stable order needle" }),
      searchDocument({ ref: "third", title: "Third", body: "stable order needle" })
    ]), "order needle");

    expect(results.map((result) => result.ref)).toEqual(["first", "second", "third"]);
  });

  it("ranks by preview length semantics without raw whitespace or over-limit text drift", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({ ref: "long-preview", title: "Long preview", body: `needle ${"x".repeat(300)}` }),
      searchDocument({ ref: "trimmed-preview", title: "Trimmed preview", body: `needle${" ".repeat(500)}` })
    ]), "needle");

    expect(results.map((result) => result.ref)).toEqual(["trimmed-preview", "long-preview"]);
  });

  it("clamps search limits to the supported range", () => {
    const index = searchIndex(matchingDocuments(105));

    expect(searchDesktopSearchIndex(index, "limit needle")).toHaveLength(100);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: 150 })).toHaveLength(100);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: 0 })).toHaveLength(1);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: -5 })).toHaveLength(1);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: 2.9 })).toHaveLength(2);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: Number.POSITIVE_INFINITY })).toHaveLength(100);
    expect(searchDesktopSearchIndex(index, "limit needle", { limit: Number.NaN })).toHaveLength(100);
  });

  it("returns only the requested limit after ranking matches", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({ ref: "body", title: "Body only", body: "rank limit needle" }),
      searchDocument({ ref: "title-includes", title: "Implement rank limit needle", body: "" }),
      searchDocument({ ref: "title-exact", title: "rank limit needle", body: "" })
    ]), "rank limit needle", { limit: 2 });

    expect(results.map((result) => result.ref)).toEqual(["title-exact", "title-includes"]);
  });

  it("keeps kind and canvas filters active when limit is applied", () => {
    const documents: DesktopSearchDocument[] = [
      searchDocument({ kind: "task", ref: "default-task", canvasId: "default", body: "filter needle" }),
      searchDocument({ kind: "block", ref: "default-block", canvasId: "default", body: "filter needle" }),
      searchDocument({ kind: "task", ref: "other-task", canvasId: "other", body: "filter needle" })
    ];
    const kinds: DesktopSearchResultKind[] = ["task"];

    const results = searchDesktopSearchIndex(searchIndex(documents), "filter needle", {
      canvasId: "default",
      kinds,
      limit: 5
    });

    expect(results.map((result) => result.ref)).toEqual(["default-task"]);
  });

  it("matches prompt documents by body and ignores prompt titles", () => {
    expect(searchDesktopSearchIndex(searchIndex([
      searchDocument({
        kind: "prompt",
        ref: "prompt-title-only",
        title: "Prompt title needle",
        body: "Prompt body without the query"
      })
    ]), "title needle", { kinds: ["prompt"] })).toEqual([]);

    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({
        kind: "prompt",
        ref: "prompt-body",
        title: "Prompt title without the query",
        body: "Prompt body needle"
      })
    ]), "body needle", { kinds: ["prompt"] });

    expect(results.map((result) => result.ref)).toEqual(["prompt-body"]);
  });

  it("uses body excerpts when the body matches and title excerpts only for title-only matches", () => {
    const results = searchDesktopSearchIndex(searchIndex([
      searchDocument({
        ref: "body-and-title",
        title: "Title needle",
        body: "Body needle source"
      }),
      searchDocument({
        ref: "title-only",
        title: "Title-only needle source",
        body: "Body without the query"
      })
    ]), "needle");

    expect(results.find((result) => result.ref === "body-and-title")?.excerpt).toBe("Body needle source");
    expect(results.find((result) => result.ref === "title-only")?.excerpt).toBe("Title-only needle source");
  });
});
