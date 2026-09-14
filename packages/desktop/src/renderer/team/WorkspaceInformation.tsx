import type { ActiveWorkspaceConnectionView } from "@planweave-ai/collaboration-protocol/connection";
import type { createTranslator } from "../i18n";
import {
  workspaceDisplayName,
  workspaceIdentityStatusLabel
} from "./workspaceConnectionPresentation";

export function WorkspaceInformation({
  connection,
  t
}: {
  connection: ActiveWorkspaceConnectionView;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="max-w-3xl space-y-8" data-testid="workspace-information">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-6 gap-y-5 border-b border-border/70 pb-6 text-sm">
        <dt className="text-text-muted">{t("workspaceNavigation")}</dt>
        <dd className="font-medium text-text-strong">
          {workspaceDisplayName(connection.workspaceDisplayName, t)}
        </dd>
        <dt className="text-text-muted">{t("workspaceIdLabel")}</dt>
        <dd className="break-all text-text-muted">{connection.workspaceId}</dd>
        <dt className="text-text-muted">Server</dt>
        <dd className="break-all">{connection.profile?.serverBaseUrl}</dd>
        <dt className="text-text-muted">{t("executorsStatusColumn")}</dt>
        <dd>{workspaceIdentityStatusLabel(connection, t)}</dd>
      </dl>
    </div>
  );
}
