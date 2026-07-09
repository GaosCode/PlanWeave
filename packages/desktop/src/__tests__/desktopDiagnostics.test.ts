import { describe, expect, it } from "vitest";
import {
  desktopDiagnosticSource,
  groupDesktopDiagnostics,
  uniqueDesktopDiagnostics
} from "../renderer/diagnostics";

describe("desktop diagnostics", () => {
  it("classifies diagnostics by code and prefix", () => {
    expect(desktopDiagnosticSource({ code: "desktop_search_index_slow_part" })).toBe("performance");
    expect(desktopDiagnosticSource({ code: "manifest_schema" })).toBe("package");
    expect(desktopDiagnosticSource({ code: "prompt_missing" })).toBe("package");
    expect(desktopDiagnosticSource({ code: "desktop_result_metadata_read_failed" })).toBe("search");
    expect(desktopDiagnosticSource({ code: "desktop_results_index_byte_limit_exceeded" })).toBe(
      "search"
    );
    expect(desktopDiagnosticSource({ code: "auto_run_state_invalid_json" })).toBe("runtime");
    expect(desktopDiagnosticSource({ code: "desktop_canvas_runtime_input_failed" })).toBe(
      "runtime"
    );
    expect(desktopDiagnosticSource({ code: "project_graph_schema" })).toBe("project");
    expect(desktopDiagnosticSource({ code: "project_cross_task_from_missing" })).toBe("project");
    expect(desktopDiagnosticSource({ code: "task_orphaned", source: "graph_quality" })).toBe(
      "graphQuality"
    );
    expect(
      desktopDiagnosticSource({ code: "no_ready_blocks", source: "execution_readiness" })
    ).toBe("graphQuality");
    expect(desktopDiagnosticSource({ code: "unknown_diagnostic" })).toBe("other");
  });

  it("groups diagnostics in source order", () => {
    const groups = groupDesktopDiagnostics([
      { code: "desktop_result_metadata_read_failed", message: "Search issue." },
      { code: "unknown_diagnostic", message: "Other issue." },
      { code: "desktop_projection_slow_part", message: "Slow projection." },
      { code: "task_orphaned", message: "Graph quality warning.", source: "graph_quality" },
      { code: "auto_run_event_log_bad_line", message: "Bad event log." }
    ]);

    expect(groups.map((group) => group.source)).toEqual([
      "performance",
      "search",
      "runtime",
      "graphQuality",
      "other"
    ]);
  });

  it("deduplicates diagnostics by code, message, and path", () => {
    expect(
      uniqueDesktopDiagnostics([
        { code: "prompt_missing", message: "Prompt missing.", path: "nodes/T-001/prompt.md" },
        { code: "prompt_missing", message: "Prompt missing.", path: "nodes/T-001/prompt.md" },
        { code: "prompt_missing", message: "Prompt missing.", path: "nodes/T-002/prompt.md" }
      ])
    ).toEqual([
      { code: "prompt_missing", message: "Prompt missing.", path: "nodes/T-001/prompt.md" },
      { code: "prompt_missing", message: "Prompt missing.", path: "nodes/T-002/prompt.md" }
    ]);
  });
});
