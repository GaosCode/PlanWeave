import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AccessMutationResult,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { LockKeyholeIcon, UsersRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { CurrentCanvasVisibilityScope } from "../hooks/useCurrentCanvasAccess";

export type CurrentCanvasAccessPanelProps = {
  view: CurrentCanvasAccessView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  scopeSelector?: ReactNode;
  compact?: boolean;
  t: ReturnType<typeof createTranslator>;
  onRefresh: () => Promise<void>;
  onUpdateVisibility: (
    scopeKind: CurrentCanvasVisibilityScope,
    visibility: "private" | "shared"
  ) => Promise<AccessMutationResult | null>;
};

function reasonLabel(
  reason: CurrentCanvasAccessView["canvas"]["disabledReason"] | "capability_denied",
  t: ReturnType<typeof createTranslator>
): string {
  const labels = {
    membership_missing: t("accessReasonMembershipMissing"),
    membership_revoked: t("accessReasonMembershipRevoked"),
    session_missing: t("accessReasonSessionMissing"),
    session_expired: t("accessReasonSessionExpired"),
    session_revoked: t("accessReasonSessionRevoked"),
    scope_private: t("accessReasonScopePrivate"),
    grant_revoked: t("accessReasonGrantRevoked"),
    capability_denied: t("accessReasonCapabilityDenied"),
    acl_revision_conflict: t("accessReasonRevisionConflict"),
    cross_workspace: t("accessReasonCrossWorkspace"),
    cross_project: t("accessReasonCrossProject"),
    cross_canvas: t("accessReasonCrossCanvas")
  } as const;
  return labels[reason ?? "capability_denied"];
}

function errorLabel(error: string, t: ReturnType<typeof createTranslator>): string {
  const knownReasons = [
    "membership_missing",
    "membership_revoked",
    "session_missing",
    "session_expired",
    "session_revoked",
    "scope_private",
    "grant_revoked",
    "capability_denied",
    "acl_revision_conflict",
    "cross_workspace",
    "cross_project",
    "cross_canvas"
  ] as const;
  const reason = knownReasons.find((candidate) => candidate === error);
  return reason ? reasonLabel(reason, t) : error;
}

/** Controls the canvas sharing scope without managing individual grants. */
export function CurrentCanvasAccessPanel({
  view,
  loading,
  error,
  busy,
  scopeSelector,
  compact = false,
  t,
  onRefresh,
  onUpdateVisibility
}: CurrentCanvasAccessPanelProps) {
  const [visibility, setVisibility] = useState(view?.canvasVisibility);
  const [outcome, setOutcome] = useState<"saved" | "failed" | null>(null);
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: selecting another resource discards its previous visibility draft.
  useEffect(() => {
    setVisibility(view?.canvasVisibility);
    setOutcome(null);
  }, [view?.canvasVisibility, view?.scope.canvasId, view?.scope.projectId]);
  const save = async () => {
    if (!view || !visibility || !view.canvas.capabilities.visibility || busy || lock.current)
      return;
    lock.current = true;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onUpdateVisibility("canvas", visibility);
      setOutcome(result?.status === "applied" ? "saved" : "failed");
    } catch {
      setOutcome("failed");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  const changed = visibility !== view?.canvasVisibility;
  return (
    <section className="min-w-0" data-testid="canvas-access-panel">
      {scopeSelector}
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-semibold">{t("accessCanvasVisibility")}</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || loading || saving}
          data-testid="canvas-access-refresh"
          onClick={() => void onRefresh()}
        >
          {t("peopleRefresh")}
        </Button>
      </div>
      {loading ? (
        <p role="status" className="py-3 text-sm text-text-muted">
          {t("accessLoading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="py-3 text-sm text-destructive">
          {errorLabel(error, t)}
        </p>
      ) : null}
      {!view && !loading && !error ? (
        <p className="py-4 text-sm text-text-muted">{t("accessScopeEmpty")}</p>
      ) : null}
      {view ? (
        <>
          <div
            className={`mt-3 grid gap-3 ${compact ? "" : "sm:grid-cols-2"}`}
            role="radiogroup"
            aria-label={t("accessCanvasVisibility")}
            data-testid="canvas-access-canvas-visibility"
          >
            {(["private", "shared"] as const).map((choice) => {
              const Icon = choice === "private" ? LockKeyholeIcon : UsersRoundIcon;
              const allowed = view.canvas.capabilities.visibility;
              return (
                <label
                  key={choice}
                  className={`flex items-start gap-3 rounded-lg border p-4 ${visibility === choice ? "border-sky-400 bg-sky-50/60 dark:border-sky-700 dark:bg-sky-950/30" : "border-border/70"}`}
                >
                  <input
                    type="radio"
                    name="canvas-visibility"
                    checked={visibility === choice}
                    disabled={!allowed || busy || saving || loading}
                    className="mt-1 accent-sky-600"
                    data-testid={`canvas-access-canvas-${choice}`}
                    title={!allowed ? reasonLabel(view.canvas.disabledReason, t) : undefined}
                    onChange={() => {
                      setVisibility(choice);
                      setOutcome(null);
                    }}
                  />
                  <Icon className="mt-1 size-4 shrink-0 text-text-muted" />
                  <span>
                    <span className="text-sm font-medium">
                      {t(
                        choice === "private" ? "accessVisibilityPrivate" : "accessVisibilityShared"
                      )}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-text-muted">
                      {t(
                        choice === "private"
                          ? "accessVisibilityPrivateHint"
                          : "accessVisibilitySharedHint"
                      )}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {outcome ? (
            <p className="mt-4 text-sm" role={outcome === "failed" ? "alert" : "status"}>
              {t(outcome === "failed" ? "accessSaveFailed" : "accessSaved")}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={!changed || busy || saving}
              onClick={() => {
                setVisibility(view.canvasVisibility);
                setOutcome(null);
              }}
            >
              {t("accessCancelChanges")}
            </Button>
            <Button
              disabled={
                !changed || !view.canvas.capabilities.visibility || busy || loading || saving
              }
              data-testid="canvas-access-save"
              onClick={() => void save()}
            >
              {saving ? t("peopleWorking") : t("saveChanges")}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
