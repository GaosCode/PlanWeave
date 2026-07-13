import { useEffect, useState, type ReactNode } from "react";
import { FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import type { createTranslator } from "../i18n";
import type { GitHubAuthStatus, ProjectGitStatus } from "../../shared/gitIntegration";

type SettingsGitSectionProps = {
  projectId: string | null;
  getGitStatus: (projectId: string) => Promise<ProjectGitStatus>;
  getGitHubAuthStatus: () => Promise<GitHubAuthStatus>;
  gitHubLogin: (token: string) => Promise<GitHubAuthStatus>;
  gitHubLogout: () => Promise<void>;
  t: ReturnType<typeof createTranslator>;
};

function SettingGroup({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text-strong">{title}</h2>
      <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">{children}</FieldGroup>
    </section>
  );
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${ok ? "bg-state-success/20 text-state-success" : "bg-state-error/20 text-state-error"}`}>
      <span className={`inline-block size-1.5 rounded-full ${ok ? "bg-state-success" : "bg-state-error"}`} />
      {label}
    </span>
  );
}

function StatusRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-text">{label}</span>
      <span className="text-sm text-text-muted">{value}</span>
    </div>
  );
}

export function SettingsGitSection({ projectId, getGitStatus, getGitHubAuthStatus, gitHubLogin, gitHubLogout, t }: SettingsGitSectionProps) {
  const [gitStatus, setGitStatus] = useState<ProjectGitStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<GitHubAuthStatus | null>(null);
  const [loginToken, setLoginToken] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  useEffect(() => {
    if (projectId) {
      getGitStatus(projectId).then(setGitStatus);
    }
    getGitHubAuthStatus().then(setAuthStatus);
  }, [projectId, getGitStatus, getGitHubAuthStatus]);

  return (
    <section data-testid="settings-section-git" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-text-strong">{t("gitAndGitHub")}</h1>
        <p className="mt-1 text-sm text-text-muted">{t("gitAndGitHubHint")}</p>
      </div>

      <SettingGroup title={t("gitRepository")}>
        {!projectId ? (
          <div className="px-4 py-4 text-sm text-text-muted">{t("gitNoProjectOpen")}</div>
        ) : gitStatus?.error ? (
          <StatusRow label={t("gitStatus")} value={<StatusBadge ok={false} label={gitStatus.error} />} />
        ) : gitStatus?.status ? (
          <>
            <StatusRow label={t("gitBranch")} value={gitStatus.status.branch} />
            <StatusRow
              label={t("gitAheadBehind")}
              value={`+${gitStatus.status.ahead} / -${gitStatus.status.behind}`}
            />
            <StatusRow
              label={t("gitStatus")}
              value={<StatusBadge ok={gitStatus.status.clean} label={gitStatus.status.clean ? t("gitClean") : t("gitDirty")} />}
            />
            {gitStatus.status.clean ? null : (
              <div className="border-t border-border/60 px-4 py-3">
                <p className="text-xs text-text-muted">{gitStatus.status.files.length} {t("gitFileCount")}</p>
                <div className="mt-1 max-h-40 overflow-y-auto text-xs">
                  {gitStatus.status.files.map((f: { path: string; staged: boolean; indexStatus: string; worktreeStatus: string }) => (
                    <div key={f.path} className="flex gap-2 py-0.5 font-mono text-text-muted">
                      <span className="w-10 shrink-0">
                        {f.staged ? `[+${f.indexStatus}]` : ` ${f.worktreeStatus}`}
                      </span>
                      <span className="truncate">{f.path}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="px-4 py-4 text-sm text-text-muted">Loading...</div>
        )}
      </SettingGroup>

      <Separator />

      <SettingGroup title={t("gitHubAuthentication")}>
        {authStatus?.authenticated ? (
          <>
            <StatusRow label={t("gitHubLogin")} value={authStatus.login} />
            <StatusRow
              label={t("gitHubSource")}
              value={authStatus.source === "env" ? "PLANWEAVE_GITHUB_TOKEN" : authStatus.source === "planweave_store" ? t("gitHubPlanweaveStore") : authStatus.source === "gh_cli" ? "gh CLI" : "git credential"}
            />
            <StatusRow
              label={t("gitHubScopes")}
              value={authStatus.scopes.length > 0 ? authStatus.scopes.join(", ") : t("gitHubNone")}
            />
            <StatusRow
              label={t("gitHubStatus")}
              value={<StatusBadge ok label={t("gitHubConnected")} />}
            />
            <div className="border-t border-border/60 px-4 py-3">
              <Button
                variant="outline"
                onClick={async () => {
                  await gitHubLogout();
                  setAuthStatus(null);
                }}
              >
                {t("gitHubLogout")}
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-4">
            <p className="text-sm text-text-muted">{t("gitHubNotAuthenticated")}</p>
            <div className="flex gap-2">
              <Input
                className="h-9 flex-1"
                placeholder={t("gitHubTokenPlaceholder")}
                value={loginToken}
                onChange={(e) => setLoginToken((e.target as HTMLInputElement).value)}
              />
              <Button
                disabled={!loginToken.trim() || loginLoading}
                onClick={async () => {
                  setLoginLoading(true);
                  try {
                    const status = await gitHubLogin(loginToken.trim());
                    setAuthStatus(status);
                    if (status.authenticated) {
                      setLoginToken("");
                    }
                  } finally {
                    setLoginLoading(false);
                  }
                }}
              >
                {loginLoading ? t("gitHubConnecting") : t("gitHubConnect")}
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              {t("gitHubTokenHint")}
            </p>
          </div>
        )}
      </SettingGroup>
    </section>
  );
}
