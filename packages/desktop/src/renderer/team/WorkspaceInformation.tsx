import type { ReactNode } from "react";
import type { ActiveWorkspaceConnectionView } from "@planweave-ai/collaboration-protocol/connection";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import {
  workspaceDisplayName,
  workspaceIdentityStatusLabel
} from "./workspaceConnectionPresentation";

export function WorkspaceInformation({
  connection,
  invitation,
  onManageInvitations,
  t
}: {
  connection: ActiveWorkspaceConnectionView;
  invitation: ReactNode;
  onManageInvitations?: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="max-w-3xl space-y-8" data-testid="workspace-information">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-6 gap-y-5 border-b border-border/70 pb-6 text-sm">
        <dt className="text-text-muted">{t("workspaceNavigation")}</dt>
        <dd className="font-medium text-text-strong">
          {workspaceDisplayName(connection.workspaceDisplayName, t)}
        </dd>
        <dt className="text-text-muted">Server</dt>
        <dd className="break-all">{connection.profile?.serverBaseUrl}</dd>
        <dt className="text-text-muted">{t("executorsStatusColumn")}</dt>
        <dd>{workspaceIdentityStatusLabel(connection, t)}</dd>
      </dl>
      {invitation || (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{t("workspaceInvitationHeading")}</h2>
          <p className="text-sm leading-6 text-text-muted">
            {t("workspaceInvitationContactOwner")}
          </p>
        </section>
      )}
      {onManageInvitations ? (
        <Button variant="outline" size="sm" onClick={onManageInvitations}>
          {t("workspaceManageInvitations")}
        </Button>
      ) : null}
    </div>
  );
}
