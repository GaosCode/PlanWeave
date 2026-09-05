import { ClipboardCopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  OperatorMemberSetupCodeHandoffView,
  OperatorProfileView
} from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type HostMemberSetupCardProps = {
  activeProfile: OperatorProfileView | null;
  workspace: { workspaceId: string; displayName: string; serverBaseUrl: string };
  busy: boolean;
  error: string | null;
  copyMemberSetupCode: () => Promise<OperatorMemberSetupCodeHandoffView | null>;
  dismissMemberSetupCodeHandoff: () => void;
  memberSetupCodeHandoff: OperatorMemberSetupCodeHandoffView | null;
  t: ReturnType<typeof createTranslator>;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

/** Copy member-device connection details for another computer to paste in Settings. */
export function HostMemberSetupCard({
  activeProfile,
  workspace,
  busy,
  error,
  copyMemberSetupCode,
  dismissMemberSetupCodeHandoff,
  memberSetupCodeHandoff,
  t
}: HostMemberSetupCardProps) {
  const locale = t("hostAdminLocale");
  const canCreate = Boolean(activeProfile?.hasOperatorCredential);

  return (
    <section className="flex flex-col gap-3" data-testid="host-admin-member-setup">
      <div className="max-w-3xl">
        <h2 className="text-sm font-semibold text-text-strong">{t("hostAdminMemberSetupTitle")}</h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">
          {t("hostAdminMemberSetupDescription")}
        </p>
      </div>
      <div className="grid gap-1 text-sm" data-testid="host-admin-member-setup-target">
        <span>
          {t("hostAdminMemberSetupWorkspace")}: {workspace.displayName}
        </span>
        <span className="break-all text-xs text-text-muted">{workspace.workspaceId}</span>
        <span className="break-all text-xs text-text-muted">{workspace.serverBaseUrl}</span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-3 grid max-w-3xl gap-3">
        {canCreate ? (
          <>
            <p className="max-w-2xl text-xs leading-5 text-text-muted">
              {t("hostAdminMemberSetupRoleNote")}
            </p>
            <Button
              type="button"
              className="w-fit"
              data-testid="host-admin-copy-member-setup"
              disabled={busy}
              onClick={() => void copyMemberSetupCode()}
            >
              <ClipboardCopyIcon data-icon="inline-start" />
              {busy ? t("peopleWorking") : t("hostAdminMemberSetupCopy")}
            </Button>
          </>
        ) : (
          <div className="max-w-2xl border-l-2 border-border pl-3">
            <p className="text-sm font-medium text-text-strong">
              {t("hostAdminMemberSetupRequiresAdmin")}
            </p>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t("hostAdminMemberSetupRoleNote")}
            </p>
          </div>
        )}
        {memberSetupCodeHandoff?.workspaceId === workspace.workspaceId && canCreate ? (
          <div
            className="grid gap-2 border-l-2 border-emerald-500 pl-3"
            data-testid="host-admin-member-setup-copied"
            role="status"
          >
            <div className="font-medium text-text-strong">{t("hostAdminMemberSetupCopied")}</div>
            <p className="text-xs leading-5 text-text-muted">
              {t("hostAdminMemberSetupExpires")}:{" "}
              {formatDate(memberSetupCodeHandoff.expiresAt, locale)}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-fit"
              data-testid="host-admin-member-setup-dismiss"
              onClick={dismissMemberSetupCodeHandoff}
            >
              {t("hostAdminMemberSetupDismiss")}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
