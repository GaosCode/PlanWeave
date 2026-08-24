import { describe, expect, it } from "vitest";
import { RemoteBlockRuntimeError, RemoteOwnershipConflictError } from "@planweave-ai/runtime";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import {
  classifyReenterFailure,
  diagnosticFromReenterFailure,
  isMissingActiveOwnership,
  isWritebackDomainFailure
} from "../remoteReenterRecovery.js";

describe("remoteReenterRecovery", () => {
  it("defers host catalog failures", () => {
    expect(
      classifyReenterFailure(new AgentEndpointCatalogError("agent_endpoint_unavailable"))
    ).toBe("defer_host");
  });

  it("defers recovery until the Canvas Runtime reconnects", () => {
    const error = new CanvasRuntimeUnavailableError("host_offline");

    expect(classifyReenterFailure(error)).toBe("defer_host");
    expect(diagnosticFromReenterFailure(error)).toEqual({
      code: "canvas_runtime_unavailable",
      message: "canvas_runtime_unavailable"
    });
  });

  it("seals any writeback domain failure, not only one code", () => {
    expect(
      classifyReenterFailure(
        new RemoteBlockRuntimeError(
          "remote_block_result_conflict",
          "Remote review result is not valid review-result JSON."
        )
      )
    ).toBe("seal_failed");
    expect(
      classifyReenterFailure(
        new RemoteBlockRuntimeError(
          "remote_block_source_changed",
          "Remote source changed before writeback."
        )
      )
    ).toBe("seal_failed");
    expect(
      isWritebackDomainFailure(
        new RemoteBlockRuntimeError("remote_block_not_dispatchable", "not dispatchable")
      )
    ).toBe(true);
  });

  it("seals missing active ownership and known op-local messages", () => {
    expect(
      classifyReenterFailure(
        new RemoteOwnershipConflictError(
          "remote_ownership_not_active",
          "The block is not bound to an active remote dispatch."
        )
      )
    ).toBe("seal_failed");
    expect(
      isMissingActiveOwnership(
        new RemoteOwnershipConflictError("remote_ownership_not_active", "gone")
      )
    ).toBe(true);
    expect(classifyReenterFailure(new Error("remote_source_changed"))).toBe("seal_failed");
    expect(diagnosticFromReenterFailure(new Error("remote_source_changed"))).toEqual({
      code: "remote_source_changed",
      message: "remote_source_changed"
    });
  });

  it("keeps crash-injection and aggregate infrastructure failures fatal", () => {
    expect(classifyReenterFailure(new Error("injected_crash:after_runtime_writeback"))).toBe(
      "fatal"
    );
    expect(
      classifyReenterFailure(new AggregateError([new Error("left"), new Error("right")]))
    ).toBe("fatal");
    expect(classifyReenterFailure(new Error("reservation_version_conflict"))).toBe("fatal");
  });
});
