import { useEffect, useRef, useState } from "react";
import type {
  ActiveCanvasPersonGrant,
  AccessMutationResult,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import { accessRoleLabel, personAccessSource } from "./accessPresentation";

type Scope = "project" | "canvas";
type Choice = "none" | "viewer" | "editor";
export type CurrentCanvasMemberAccessProps = {
  view: CurrentCanvasAccessView;
  person: CurrentCanvasAccessView["people"][number];
  busy: boolean;
  t: ReturnType<typeof createTranslator>;
  onGrant: (
    personId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
    role: "viewer" | "editor",
    scope: Scope
  ) => Promise<AccessMutationResult | null>;
  onRevoke: (grant: ActiveCanvasPersonGrant) => Promise<AccessMutationResult | null>;
};

export function CurrentCanvasMemberAccess({
  view,
  person,
  busy,
  t,
  onGrant,
  onRevoke
}: CurrentCanvasMemberAccessProps) {
  const project = person.grants.find((grant) => grant.scopeKind === "project");
  const canvas = person.grants.find((grant) => grant.scopeKind === "canvas");
  const [draft, setDraft] = useState<Record<Scope, Choice>>({
    project: project?.role ?? "none",
    canvas: canvas?.role ?? "none"
  });
  const baseline = useRef<Record<Scope, Choice>>({
    project: project?.role ?? "none",
    canvas: canvas?.role ?? "none"
  });
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const [outcome, setOutcome] = useState<"saved" | "failed" | null>(null);
  useEffect(() => {
    const previous = baseline.current;
    const next = {
      project: project?.role ?? "none",
      canvas: canvas?.role ?? "none"
    } satisfies Record<Scope, Choice>;
    setDraft((current) => ({
      project: current.project === previous.project ? next.project : current.project,
      canvas: current.canvas === previous.canvas ? next.canvas : current.canvas
    }));
    baseline.current = next;
  }, [project?.role, canvas?.role]);
  const changed =
    draft.project !== (project?.role ?? "none") || draft.canvas !== (canvas?.role ?? "none");
  const allowed = (["project", "canvas"] as const).every((scope) => {
    const current = scope === "project" ? project : canvas;
    return (
      draft[scope] === (current?.role ?? "none") ||
      (draft[scope] === "none" ? view[scope].capabilities.revoke : view[scope].capabilities.grant)
    );
  });
  const save = async () => {
    if (busy || lock.current || !changed || !allowed) return;
    lock.current = true;
    setSaving(true);
    setOutcome(null);
    try {
      for (const scope of ["project", "canvas"] as const) {
        const grant = scope === "project" ? project : canvas;
        const choice = draft[scope];
        if (choice === (grant?.role ?? "none")) continue;
        const result =
          choice === "none"
            ? grant
              ? await onRevoke(grant)
              : null
            : await onGrant(person.humanPrincipalId, choice, scope);
        if (result?.status !== "applied") {
          setOutcome("failed");
          return;
        }
      }
      setOutcome("saved");
    } catch {
      setOutcome("failed");
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="canvas-member-access">
      <div className="divide-y divide-border/60">
        {(["project", "canvas"] as const).map((scope) => {
          const access = view[scope];
          const existing = scope === "project" ? project : canvas;
          return (
            <div key={scope} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <h3 className="text-sm font-semibold">
                  {t(scope === "project" ? "accessProjectGrant" : "accessCanvasGrant")}
                </h3>
                <p className="mt-1 text-xs text-text-muted">
                  {t(scope === "project" ? "accessProjectGrantHint" : "accessCanvasGrantHint")}
                </p>
              </div>
              <fieldset
                aria-label={t(scope === "project" ? "accessProjectGrant" : "accessCanvasGrant")}
                className="flex rounded-md border border-border p-1"
              >
                {(["none", "viewer", "editor"] as const).map((choice) => (
                  <Button
                    key={choice}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={
                      draft[scope] === choice
                        ? "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200"
                        : "text-text-muted"
                    }
                    aria-pressed={draft[scope] === choice}
                    data-testid={`canvas-access-grant-${scope}-${choice}`}
                    disabled={
                      busy ||
                      saving ||
                      (choice === "none"
                        ? Boolean(existing) && !access.capabilities.revoke
                        : !access.capabilities.grant)
                    }
                    onClick={() => {
                      setDraft((current) => ({ ...current, [scope]: choice }));
                      setOutcome(null);
                    }}
                  >
                    {t(
                      choice === "none"
                        ? "accessNoDirectGrant"
                        : choice === "viewer"
                          ? "accessViewChoice"
                          : "accessEditChoice"
                    )}
                  </Button>
                ))}
              </fieldset>
            </div>
          );
        })}
      </div>
      <div
        className="rounded-md border border-sky-200/60 bg-sky-50/60 px-4 py-3 dark:border-sky-900 dark:bg-sky-950/30"
        data-testid="member-effective-access"
      >
        <p className="text-sm font-semibold">
          {t("accessMemberEffectiveRole")}: {accessRoleLabel(person.effectiveRole, t)}
        </p>
        <p className="mt-1 text-xs text-text-muted">{personAccessSource(person, t)}</p>
      </div>
      <p className="text-xs leading-5 text-text-muted">{t("accessInheritanceHint")}</p>
      {outcome ? (
        <p
          role={outcome === "failed" ? "alert" : "status"}
          className={outcome === "failed" ? "text-sm text-destructive" : "text-sm text-emerald-700"}
        >
          {t(outcome === "failed" ? "accessSaveFailed" : "accessSaved")}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-3">
        <Button
          variant="outline"
          disabled={!changed || busy || saving}
          onClick={() => {
            setDraft({ project: project?.role ?? "none", canvas: canvas?.role ?? "none" });
            setOutcome(null);
          }}
        >
          {t("accessCancelChanges")}
        </Button>
        <Button disabled={!changed || !allowed || busy || saving} onClick={() => void save()}>
          {saving ? t("peopleWorking") : t("saveChanges")}
        </Button>
      </div>
    </div>
  );
}
