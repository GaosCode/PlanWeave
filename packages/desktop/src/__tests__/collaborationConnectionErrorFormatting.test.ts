import { describe, expect, it } from "vitest";
import { collaborationConnectionErrorMessage } from "../renderer/collaboration/formatCollaborationError.js";
import { createTranslator } from "../renderer/i18n.js";

describe("collaboration connection error presentation", () => {
  it("localizes local-owner recovery failures without exposing Electron IPC details", () => {
    const raw = new Error(
      "Error invoking remote method 'planweave-collaboration:registerLocalCurrentProject': Error: local_collaboration_selection_required"
    );

    const message = collaborationConnectionErrorMessage(createTranslator("en"), raw);

    expect(message).toBe(
      "The local owner identity could not be restored. Refresh the Workspace status and try again."
    );
    expect(message).not.toContain("Error invoking remote method");
    expect(message).not.toContain("registerLocalCurrentProject");
    expect(message).not.toContain("local_collaboration_selection_required");
  });

  it("uses a safe localized fallback for unexpected connection failures", () => {
    const raw = new Error(
      "Error invoking remote method 'planweave-collaboration:connectSession': Error: internal_detail"
    );

    const message = collaborationConnectionErrorMessage(createTranslator("zh-CN"), raw);

    expect(message).toBe("连接操作失败，请刷新状态后重试。");
    expect(message).not.toContain("Error invoking remote method");
    expect(message).not.toContain("internal_detail");
  });

  it("hides internal device-credential failures behind localized copy", () => {
    const message = collaborationConnectionErrorMessage(
      createTranslator("zh-CN"),
      new Error("Human device credential is not available for this Workspace.")
    );

    expect(message).toBe("此配置没有已存储的设备凭证。");
    expect(message).not.toContain("Human device");
  });
});
