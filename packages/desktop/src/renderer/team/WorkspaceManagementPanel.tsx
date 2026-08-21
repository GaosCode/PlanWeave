import type { ReactNode } from "react";
import type { createTranslator } from "../i18n";
import { WorkspaceSectionHeader } from "./WorkspaceSectionHeader";

export function WorkspaceManagementPanel({
  connection,
  hostedCanvases,
  contentAuthority,
  t
}: {
  connection: ReactNode;
  hostedCanvases: ReactNode;
  contentAuthority: ReactNode;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section className="flex min-w-0 flex-col" data-testid="people-workspace-management">
      <p className="max-w-4xl pb-8 text-sm leading-6 text-text-muted">
        {t("peopleRemoteWorkspaceDescription")}
      </p>

      <section
        aria-labelledby="people-workspace-identity-title"
        data-testid="people-workspace-connection-section"
      >
        <WorkspaceSectionHeader
          title={t("peopleWorkspaceIdentityTitle")}
          description={t("peopleWorkspaceIdentityDescription")}
          titleId="people-workspace-identity-title"
        />
        <div className="mt-5">{connection}</div>
      </section>
      <div className="mt-8" data-testid="people-workspace-hosting-section">
        {hostedCanvases}
      </div>
      <div data-testid="people-workspace-content-section">{contentAuthority}</div>
    </section>
  );
}
