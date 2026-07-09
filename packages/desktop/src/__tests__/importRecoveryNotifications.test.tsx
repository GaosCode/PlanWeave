/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { createTranslator } from "../renderer/i18n";
import { buildNotificationItems } from "../renderer/notifications";
import { NotificationsView } from "../renderer/views/NotificationsView";

afterEach(cleanup);

describe("import recovery notifications", () => {
  it("builds a pending import recovery notification from runtime summaries", () => {
    const notifications = buildNotificationItems({
      autoRunState: null,
      fileSyncDiagnostics: [],
      graph: null,
      lastFileChange: null,
      pendingImportRecoveries: [
        {
          transactionId: "import-tx-1",
          recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1",
          createdAt: "2026-07-06T00:00:00.000Z",
          operationCount: 3,
          phases: ["prepared", "applied"]
        }
      ],
      promptConflicts: [],
      settings: defaultDesktopSettings,
      t: createTranslator("en")
    });

    expect(notifications).toEqual([
      {
        id: "import-recovery:import-tx-1",
        title: "Unfinished import recovery found",
        detail: "Transaction: import-tx-1 · Operations: 3 · Phases: prepared, applied",
        tone: "destructive",
        kind: "importRecovery",
        transactionId: "import-tx-1",
        recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1",
        read: false
      }
    ]);
  });

  it("renders recovery directory and passes actions to injected callbacks", async () => {
    const onCopyImportRecoveryTransactionId = vi.fn().mockResolvedValue(undefined);
    const onRevealImportRecoveryDirectory = vi.fn().mockResolvedValue(undefined);
    const onRollbackImportRecovery = vi.fn().mockResolvedValue(undefined);
    const recoveryRoot =
      "/tmp/project/desktop/recovery/package-import/import-tx-1/with/a/very/long/path/that/should/wrap/safely";

    render(
      <NotificationsView
        notificationItems={[
          {
            id: "import-recovery:import-tx-1",
            title: "发现未完成的导入恢复",
            detail: "事务: import-tx-1 · 操作数: 3 · 阶段: prepared, applied",
            tone: "destructive",
            read: false,
            kind: "importRecovery",
            transactionId: "import-tx-1",
            recoveryRoot
          }
        ]}
        onApplyLocalPromptConflicts={vi.fn()}
        onKeepLocalPromptConflicts={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onCopyImportRecoveryTransactionId={onCopyImportRecoveryTransactionId}
        onOpenGraph={vi.fn()}
        onReloadPromptConflicts={vi.fn()}
        onRevealImportRecoveryDirectory={onRevealImportRecoveryDirectory}
        onRollbackImportRecovery={onRollbackImportRecovery}
        refreshPackageFiles={vi.fn()}
        t={createTranslator("zh-CN")}
      />
    );

    expect(screen.getByTestId("import-recovery-directory")).toHaveTextContent(recoveryRoot);
    expect(screen.getByTestId("import-recovery-directory")).toHaveClass("break-all");

    await userEvent.click(screen.getByRole("button", { name: "打开恢复目录" }));
    await userEvent.click(screen.getByRole("button", { name: "复制事务 ID" }));
    await userEvent.click(screen.getByRole("button", { name: "回滚导入" }));

    expect(onRevealImportRecoveryDirectory).toHaveBeenCalledWith(recoveryRoot);
    expect(onCopyImportRecoveryTransactionId).toHaveBeenCalledWith("import-tx-1");
    expect(onRollbackImportRecovery).toHaveBeenCalledWith("import-tx-1");
  });

  it("disables rollback for the pending transaction and ignores duplicate clicks", async () => {
    let resolveRollback: () => void;
    const rollbackPromise = new Promise<void>((resolve) => {
      resolveRollback = resolve;
    });
    const onRollbackImportRecovery = vi.fn(() => rollbackPromise);

    render(
      <NotificationsView
        notificationItems={[
          {
            id: "import-recovery:import-tx-1",
            title: "Unfinished import recovery found",
            detail: "Transaction: import-tx-1 · Operations: 3 · Phases: prepared, applied",
            tone: "destructive",
            read: false,
            kind: "importRecovery",
            transactionId: "import-tx-1",
            recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1"
          },
          {
            id: "import-recovery:import-tx-2",
            title: "Unfinished import recovery found",
            detail: "Transaction: import-tx-2 · Operations: 1 · Phases: prepared",
            tone: "destructive",
            read: false,
            kind: "importRecovery",
            transactionId: "import-tx-2",
            recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-2"
          }
        ]}
        onApplyLocalPromptConflicts={vi.fn()}
        onKeepLocalPromptConflicts={vi.fn()}
        onMarkNotificationRead={vi.fn()}
        onOpenGraph={vi.fn()}
        onReloadPromptConflicts={vi.fn()}
        onRollbackImportRecovery={onRollbackImportRecovery}
        refreshPackageFiles={vi.fn()}
        t={createTranslator("en")}
      />
    );

    const rollbackButtons = screen.getAllByRole("button", { name: "Rollback import" });

    await userEvent.click(rollbackButtons[0]);

    expect(onRollbackImportRecovery).toHaveBeenCalledTimes(1);
    expect(onRollbackImportRecovery).toHaveBeenCalledWith("import-tx-1");
    expect(rollbackButtons[0]).toBeDisabled();
    expect(rollbackButtons[0]).toHaveAttribute("aria-busy", "true");
    expect(rollbackButtons[1]).not.toBeDisabled();

    await userEvent.click(rollbackButtons[0]);

    expect(onRollbackImportRecovery).toHaveBeenCalledTimes(1);

    resolveRollback!();
    await waitFor(() => expect(rollbackButtons[0]).not.toBeDisabled());
  });

  it("keeps an import recovery notification visible when rollback reports failure", async () => {
    const onRollbackFailure = vi.fn();
    const onMarkNotificationRead = vi.fn();
    const onRollbackImportRecovery = vi.fn(async () => {
      onRollbackFailure("rollback failed");
    });

    render(
      <NotificationsView
        notificationItems={[
          {
            id: "import-recovery:import-tx-1",
            title: "Unfinished import recovery found",
            detail: "Transaction: import-tx-1 · Operations: 3 · Phases: prepared, applied",
            tone: "destructive",
            read: false,
            kind: "importRecovery",
            transactionId: "import-tx-1",
            recoveryRoot: "/tmp/project/desktop/recovery/package-import/import-tx-1"
          }
        ]}
        onApplyLocalPromptConflicts={vi.fn()}
        onKeepLocalPromptConflicts={vi.fn()}
        onMarkNotificationRead={onMarkNotificationRead}
        onOpenGraph={vi.fn()}
        onReloadPromptConflicts={vi.fn()}
        onRollbackImportRecovery={onRollbackImportRecovery}
        refreshPackageFiles={vi.fn()}
        t={createTranslator("en")}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Rollback import" }));

    expect(onRollbackImportRecovery).toHaveBeenCalledWith("import-tx-1");
    expect(onRollbackFailure).toHaveBeenCalledWith("rollback failed");
    expect(onMarkNotificationRead).not.toHaveBeenCalled();
    expect(screen.getByText("Unfinished import recovery found")).toBeInTheDocument();
  });
});
