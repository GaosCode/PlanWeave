import type {
  OperatorHostAvailabilityReason,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";
import { RefreshCwIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type { HostInventoryState } from "../hooks/useHostAdministrationController";

type HostAvailabilityCardProps = {
  busy: boolean;
  hosts: OperatorHostView[];
  hasMore: boolean;
  inventoryState: HostInventoryState;
  loading: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  onRevoke: (host: OperatorHostView) => void;
  onRenew: (host: OperatorHostView) => void;
  t: ReturnType<typeof createTranslator>;
};

export type HostCredentialExpiryState = "current" | "expiring" | "expired" | "legacy";

export function hostCredentialExpiryState(
  host: OperatorHostView,
  now = new Date()
): HostCredentialExpiryState {
  if (!host.credentialExpiresAt || !host.credentialPolicy) return "legacy";
  const remainingMs = Date.parse(host.credentialExpiresAt) - now.getTime();
  if (remainingMs <= 0) return "expired";
  const renewalWindowDays = Math.min(
    30,
    Math.max(1, Math.floor(host.credentialPolicy.lifetimeDays * 0.2))
  );
  return remainingMs <= renewalWindowDays * 24 * 60 * 60_000 ? "expiring" : "current";
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

function availabilityReason(host: OperatorHostView): "ready" | OperatorHostAvailabilityReason {
  if (host.availability.status === "available") return "ready";
  if (host.availability.reason === null) {
    throw new Error("operator_host_availability_reason_missing");
  }
  return host.availability.reason;
}

function agentNames(host: OperatorHostView): string[] {
  return [
    ...new Set(
      (host.readinessObservation?.acpProfiles ?? [])
        .filter((profile) => profile.status === "ready")
        .map((profile) => profile.displayName)
    )
  ];
}

export function HostAvailabilityCard({
  busy,
  hosts,
  hasMore,
  inventoryState,
  loading,
  onLoadMore,
  onRefresh,
  onRevoke,
  onRenew,
  t
}: HostAvailabilityCardProps) {
  const activeHosts = hosts.filter((host) => !host.revokedAt);
  const locale = t("hostAdminLocale");

  return (
    <section className="border-b border-border/70 py-8" data-testid="host-availability">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
            {t("hostAvailabilityTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">
            {t("hostAvailabilityDescription")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="host-availability-refresh"
          disabled={
            loading ||
            inventoryState === "loading" ||
            inventoryState === "profile_missing" ||
            inventoryState === "credential_missing"
          }
          onClick={onRefresh}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("hostAdminRefresh")}
        </Button>
      </div>
      <div className="mt-5">
        {inventoryState === "ready" && hasMore ? (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3"
            role="status"
            data-testid="host-availability-partial"
          >
            <p className="text-sm text-text-strong">{t("hostAvailabilityPartial")}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="host-availability-load-more"
              disabled={loading}
              onClick={onLoadMore}
            >
              {t("hostAvailabilityLoadMore")}
            </Button>
          </div>
        ) : null}
        {inventoryState === "loading" ? (
          <div className="py-6" data-testid="host-availability-loading">
            <p className="text-sm text-text-muted">{t("hostAvailabilityLoading")}</p>
          </div>
        ) : inventoryState !== "ready" ? (
          <div className="py-6" data-testid="host-availability-unavailable">
            <p className="text-sm font-medium text-text-strong">
              {t("hostAvailabilityUnavailable")}
            </p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-text-muted">
              {t(`hostAvailabilityUnavailable_${inventoryState}`)}
            </p>
          </div>
        ) : activeHosts.length === 0 ? (
          <div className="py-6" data-testid="host-availability-empty">
            <p className="text-sm font-medium text-text-strong">{t("hostAvailabilityEmpty")}</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-text-muted">
              {t("hostAvailabilityEmptyHint")}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border/60" aria-label={t("hostAvailabilityTitle")}>
            {activeHosts.map((host) => {
              const reason = availabilityReason(host);
              const agents = agentNames(host);
              const expiryState = hostCredentialExpiryState(host);
              return (
                <li className="py-4" data-testid={`host-availability-${host.id}`} key={host.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-2 rounded-full ${
                            reason === "ready" ? "bg-emerald-500" : "bg-text-muted/50"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate font-medium text-text-strong">
                          {host.displayName}
                        </span>
                        <span
                          className={
                            reason === "ready"
                              ? "text-xs font-medium text-emerald-600"
                              : "text-xs text-text-muted"
                          }
                          data-testid={`host-availability-status-${host.id}`}
                        >
                          {t(`hostAvailability_${reason}`)}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                        {agents.length > 0 ? (
                          agents.map((agent) => (
                            <span className="text-xs text-text-strong" key={agent}>
                              {agent}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-text-muted">
                            {t("hostAvailabilityNoAgents")}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span
                          className={
                            expiryState === "expired" || expiryState === "expiring"
                              ? "text-amber-700"
                              : "text-text-muted"
                          }
                          data-testid={`host-credential-expiry-${host.id}`}
                        >
                          {host.credentialExpiresAt
                            ? t(`hostCredentialExpiry_${expiryState}`).replace(
                                "{expiry}",
                                formatDate(host.credentialExpiresAt, locale)
                              )
                            : t("hostCredentialExpiry_legacy")}
                        </span>
                        {host.credentialRenewalRequestedAt ? (
                          <span
                            className="font-medium text-amber-700"
                            data-testid={`host-credential-renewal-pending-${host.id}`}
                          >
                            {t("hostCredentialRenewalPending")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                      {host.credentialPolicy && expiryState !== "expired" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          data-testid={`host-admin-renew-${host.id}`}
                          aria-label={`${t("hostCredentialRenewNow")}: ${host.displayName}`}
                          disabled={busy || host.credentialRenewalRequestedAt !== undefined}
                          onClick={() => onRenew(host)}
                        >
                          <RotateCwIcon data-icon="inline-start" />
                          {host.credentialRenewalRequestedAt
                            ? t("hostCredentialRenewalPending")
                            : t("hostCredentialRenewNow")}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-text-muted hover:text-destructive"
                        data-testid={`host-admin-revoke-${host.id}`}
                        disabled={busy}
                        onClick={() => onRevoke(host)}
                      >
                        <Trash2Icon data-icon="inline-start" />
                        {t("hostAdminRevoke")}
                      </Button>
                    </div>
                  </div>
                  {reason !== "ready" ? (
                    <p className="mt-3 text-xs leading-5 text-text-muted">
                      {t(`hostAvailabilityAction_${reason}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
