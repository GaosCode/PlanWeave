import { describe, expect, it } from "vitest";
import { formatAgentEndpointRunError } from "../renderer/collaboration/formatAgentEndpointRunError";
import { createTranslator } from "../renderer/i18n";

describe("formatAgentEndpointRunError", () => {
  const en = createTranslator("en");
  const zh = createTranslator("zh-CN");

  it("explains execution conflicts and request failures in the user's language", () => {
    expect(formatAgentEndpointRunError("human_remote_operation_conflict", zh)).toContain(
      "运行状态发生冲突"
    );
    expect(formatAgentEndpointRunError("human_remote_operation_conflict", en)).toContain(
      "conflicts"
    );
    expect(formatAgentEndpointRunError("workspace_execution_request_failed", zh)).toContain(
      "未能启动"
    );
    expect(formatAgentEndpointRunError("workspace_execution_request_failed", en)).toContain(
      "could not be started"
    );
  });

  it("humanizes claim_bus_blocked with reason and original code", () => {
    const formatted = formatAgentEndpointRunError("claim_bus_blocked:dependency_incomplete", en);
    expect(formatted).toContain("dependency_incomplete");
    expect(formatted).toContain("run again");
    expect(formatted).toContain("[claim_bus_blocked:dependency_incomplete]");
  });

  it("humanizes claim_bus_idle and claim_bus_cancelled", () => {
    expect(formatAgentEndpointRunError("claim_bus_idle:no_claimable_blocks", en)).toContain(
      "[claim_bus_idle:no_claimable_blocks]"
    );
    expect(formatAgentEndpointRunError("claim_bus_cancelled", en)).toContain(
      "[claim_bus_cancelled]"
    );
  });

  it("humanizes collaboration runtime projection unavailable codes", () => {
    const status = formatAgentEndpointRunError("collaboration_runtime_status_unavailable", en);
    expect(status).toContain("unavailable");
    expect(status).toContain("[collaboration_runtime_status_unavailable]");

    const task = formatAgentEndpointRunError(
      "collaboration_runtime_task_status_unavailable:T-001",
      en
    );
    expect(task).toContain("T-001");
    expect(task).toContain("[collaboration_runtime_task_status_unavailable:T-001]");

    const block = formatAgentEndpointRunError(
      "collaboration_runtime_block_status_unavailable:T-001#B-001",
      en
    );
    expect(block).toContain("T-001#B-001");
    expect(block).toContain("[collaboration_runtime_block_status_unavailable:T-001#B-001]");
  });

  it("presents automatic runtime attachment as execution-environment preparation", () => {
    expect(formatAgentEndpointRunError("collaboration_runtime_state_uninitialized", en)).toContain(
      "Preparing the execution environment"
    );
    expect(formatAgentEndpointRunError("collaboration_runtime_runtime_not_attached", zh)).toContain(
      "正在准备执行环境"
    );
  });

  it("humanizes local_agent_unit failure with block and phase", () => {
    const formatted = formatAgentEndpointRunError("local_agent_unit_failed:T-002#B-001", en);
    expect(formatted).toContain("T-002#B-001");
    expect(formatted).toContain("failed");
    expect(formatted).toContain("[local_agent_unit_failed:T-002#B-001]");
  });

  it("humanizes preference mismatch and selection missing", () => {
    const mismatch = formatAgentEndpointRunError(
      "agent_endpoint_preference_mismatch:T-003#B-001:grok->codex",
      en
    );
    expect(mismatch).toContain("T-003#B-001");
    expect(mismatch).toContain("grok->codex");
    expect(mismatch).toContain("Re-select");
    expect(mismatch).toContain("[agent_endpoint_preference_mismatch:T-003#B-001:grok->codex]");

    const missing = formatAgentEndpointRunError("agent_endpoint_selection_missing:T-001#R-001", en);
    expect(missing).toContain("T-001#R-001");
    expect(missing).toContain("[agent_endpoint_selection_missing:T-001#R-001]");
  });

  it("humanizes remote failure codes and host failure shape", () => {
    const remote = formatAgentEndpointRunError("remote_agent_block_failed:T-001#B-001", en);
    expect(remote).toContain("T-001#B-001");
    expect(remote).toContain("failed");
    expect(remote).toContain("[remote_agent_block_failed:T-001#B-001]");

    const host = formatAgentEndpointRunError(
      "ACP authentication is required. (acp_authentication_required)",
      en
    );
    expect(host).toContain("ACP authentication is required.");
    expect(host).toContain("[acp_authentication_required]");
  });

  it("provides zh-CN copy with the same diagnostic code", () => {
    const formatted = formatAgentEndpointRunError(
      "agent_endpoint_preference_mismatch:T-003#B-001:grok->codex",
      zh
    );
    expect(formatted).toContain("T-003#B-001");
    expect(formatted).toContain("重新选择");
    expect(formatted).toContain("[agent_endpoint_preference_mismatch:T-003#B-001:grok->codex]");
  });

  it("passes through unknown messages", () => {
    expect(formatAgentEndpointRunError("totally_unknown_error", en)).toBe("totally_unknown_error");
  });

  it("humanizes content_out_of_sync from execute without a second Catalog resolve", () => {
    expect(formatAgentEndpointRunError("content_out_of_sync", en)).toContain(
      "Workspace execution content is not current"
    );
    expect(formatAgentEndpointRunError("content_out_of_sync", en)).toContain(
      "[content_out_of_sync]"
    );
    expect(formatAgentEndpointRunError("content_out_of_sync", zh)).toContain(
      "Workspace 执行内容不是最新版本"
    );
  });
});
