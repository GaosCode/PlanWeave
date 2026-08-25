import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type {
  CollaborationIdentityRepairView,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";

export function IdentityRepairPanel(props: {
  api: PlanWeaveCollaborationApi | null;
  repair: CollaborationIdentityRepairView;
  allowInsecureTransport: boolean;
  t: ReturnType<typeof createTranslator>;
  busy: boolean;
}) {
  const knownPrincipals = props.repair.principals.filter(
    (principal) => principal.humanPrincipalId !== null
  );
  const [sourceId, setSourceId] = useState(knownPrincipals[1]?.humanPrincipalId ?? "");
  const [canonicalId, setCanonicalId] = useState(knownPrincipals[0]?.humanPrincipalId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const canRecover = props.repair.principals.some(
    (principal) => principal.hasDeviceToken && !principal.hasIdentityToken
  );
  const canMerge =
    confirmed &&
    sourceId.length > 0 &&
    canonicalId.length > 0 &&
    sourceId !== canonicalId &&
    knownPrincipals.some((principal) => principal.humanPrincipalId === sourceId) &&
    knownPrincipals.some((principal) => principal.humanPrincipalId === canonicalId);

  return (
    <div
      className="mt-3 space-y-2 rounded-md border border-destructive/40 p-3 text-sm"
      data-testid="people-identity-repair"
    >
      <p className="font-medium text-destructive">{props.t("peopleIdentityRepairTitle")}</p>
      <p className="text-xs text-muted-foreground">{props.t("peopleIdentityRepairHint")}</p>
      <ul className="space-y-1 text-xs">
        {props.repair.principals.map((principal) => (
          <li key={principal.humanPrincipalId ?? principal.profileIds.join(",")}>
            {principal.humanPrincipalId ?? props.t("peopleIdentityRepairUnknownPrincipal")}
            {` · ${principal.profileIds.length} profile(s)`}
          </li>
        ))}
      </ul>
      {canRecover ? (
        <Button
          type="button"
          size="sm"
          data-testid="people-identity-repair-recover"
          disabled={props.busy || !props.api}
          onClick={() => {
            void props.api?.recoverCollaborationIdentities({
              serverBaseUrl: props.repair.origin.endsWith("/")
                ? props.repair.origin
                : `${props.repair.origin}/`,
              allowInsecureTransport: props.allowInsecureTransport
            });
          }}
        >
          {props.t("peopleIdentityRepairRecover")}
        </Button>
      ) : null}
      {knownPrincipals.length >= 2 ? (
        <div className="space-y-2">
          <label className="block text-xs">
            {props.t("peopleIdentityRepairCanonical")}
            <select
              className="mt-1 w-full rounded border bg-background p-1"
              data-testid="people-identity-repair-canonical"
              value={canonicalId}
              onChange={(event) => setCanonicalId(event.target.value)}
            >
              {knownPrincipals.map((principal) => (
                <option
                  key={principal.humanPrincipalId ?? ""}
                  value={principal.humanPrincipalId ?? ""}
                >
                  {principal.humanPrincipalId}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            {props.t("peopleIdentityRepairSource")}
            <select
              className="mt-1 w-full rounded border bg-background p-1"
              data-testid="people-identity-repair-source"
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              {knownPrincipals.map((principal) => (
                <option
                  key={`source-${principal.humanPrincipalId ?? ""}`}
                  value={principal.humanPrincipalId ?? ""}
                >
                  {principal.humanPrincipalId}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              data-testid="people-identity-repair-confirm"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {props.t("peopleIdentityRepairConfirm")}
          </label>
          <Button
            type="button"
            size="sm"
            data-testid="people-identity-repair-merge"
            disabled={props.busy || !props.api || !canMerge}
            onClick={() => {
              void props.api?.confirmCollaborationIdentityMerge({
                serverBaseUrl: props.repair.origin.endsWith("/")
                  ? props.repair.origin
                  : `${props.repair.origin}/`,
                allowInsecureTransport: props.allowInsecureTransport,
                sourceHumanPrincipalId: sourceId,
                canonicalHumanPrincipalId: canonicalId,
                confirmation: "merge"
              });
            }}
          >
            {props.t("peopleIdentityRepairMerge")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
