import { describe, expect, it } from "vitest";
import {
  PLANWEAVE_COMPATIBILITY_BOUNDS,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  assertGracefulPackageDowngrade,
  assertMatchingPackageMajors,
  parsePackageMajor
} from "../index.js";

describe("distributed compatibility bounds", () => {
  it("pins a single wire protocol version and fail-closed rollback rules", () => {
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.agentHostProtocolVersion).toBe(agentHostProtocolVersion);
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.packageMajorMustMatch).toEqual([
      "server",
      "agent-host",
      "agent-host-protocol"
    ]);
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.rollbackConstraints.resetDatabases).toBe(false);
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.rollbackConstraints.silentRerunInterruptedBlocks).toBe(
      false
    );
    expect(PLANWEAVE_COMPATIBILITY_BOUNDS.rollbackConstraints.requireStateBackupBeforeUpgrade).toBe(
      true
    );
  });

  it("accepts the supported protocol version and rejects other majors", () => {
    expect(assertAgentHostProtocolCompatible(agentHostProtocolVersion)).toEqual({ ok: true });
    expect(assertAgentHostProtocolCompatible(1)).toMatchObject({
      ok: false,
      code: "protocol_version_incompatible"
    });
    expect(assertAgentHostProtocolCompatible("1")).toMatchObject({ ok: false });
  });

  it("requires matching package majors before dispatch readiness", () => {
    expect(
      assertMatchingPackageMajors({
        server: "0.3.0",
        agentHost: "0.3.1",
        protocol: "0.3.0"
      })
    ).toEqual({ ok: true });
    expect(
      assertMatchingPackageMajors({
        server: "0.3.0",
        agentHost: "1.0.0"
      })
    ).toMatchObject({ ok: false, code: "package_major_mismatch" });
    expect(
      assertMatchingPackageMajors({
        server: "1.0.0",
        agentHost: "1.0.0",
        protocol: "2.0.0"
      })
    ).toEqual({
      ok: false,
      code: "package_major_mismatch",
      message: "agent-host-protocol major 2 is incompatible with Server major 1."
    });
    expect(parsePackageMajor("1.2.3-beta.1")).toBe(1);
  });

  it("allows same-major downgrade only", () => {
    expect(assertGracefulPackageDowngrade({ fromVersion: "0.3.2", toVersion: "0.3.0" })).toEqual({
      ok: true
    });
    expect(
      assertGracefulPackageDowngrade({ fromVersion: "1.0.0", toVersion: "0.9.0" })
    ).toMatchObject({ ok: false, code: "package_downgrade_major_forbidden" });
  });
});
