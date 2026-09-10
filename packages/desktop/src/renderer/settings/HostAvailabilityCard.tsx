import type {
  OperatorHostAvailabilityReason,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";
import { useState } from "react";
import { ManagementDialog } from "../components/ManagementDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { EllipsisIcon, RefreshCwIcon } from "lucide-react";
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
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const activeHosts = hosts.filter((host) => !host.revokedAt);
  const locale = t("hostAdminLocale");

  return (
    <section className="border-b border-border/70" data-testid="host-availability">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
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
          <ul
            className="divide-y divide-border/60 overflow-x-auto"
            aria-label={t("hostAvailabilityTitle")}
          >
            <li
              className="grid grid-cols-[minmax(10rem,1fr)_minmax(7rem,.7fr)_minmax(8rem,1fr)_auto] gap-4 pb-3 text-xs text-text-muted"
              aria-hidden="true"
            >
              <span>{t("executorsDevices")}</span>
              <span>{t("executorsStatusColumn")}</span>
              <span>{t("executorsNavigation")}</span>
              <span className="w-20" />
            </li>
            {activeHosts.map((host) => {
              const reason = availabilityReason(host);
              const agents = agentNames(host);
              const expiryState = hostCredentialExpiryState(host);
              return (
                <li
                  className="grid grid-cols-[minmax(10rem,1fr)_minmax(7rem,.7fr)_minmax(8rem,1fr)_auto] items-center gap-4 py-5 text-sm"
                  data-testid={`host-availability-${host.id}`}
                  key={host.id}
                >
                  <span className="truncate font-medium text-text-strong">{host.displayName}</span>
                  <span
                    className={`flex items-center gap-2 ${reason === "ready" ? "text-emerald-700 dark:text-emerald-400" : "text-text-muted"}`}
                    data-testid={`host-availability-status-${host.id}`}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${reason === "ready" ? "bg-emerald-500" : "bg-text-muted/40"}`}
                    />
                    {t(`hostAvailability_${reason}`)}
                  </span>
                  <span className="text-text-muted">
                    {agents.length ? agents.join(" · ") : t("hostAvailabilityNoAgents")}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-sky-700 dark:text-sky-400"
                      onClick={() => setSelectedHostId(host.id)}
                    >
                      {t("managementDetails")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t("managementActions")}: ${host.displayName}`}
                        >
                          <EllipsisIcon className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {host.credentialPolicy && expiryState !== "expired" ? (
                          <DropdownMenuItem
                            data-testid={`host-admin-renew-${host.id}`}
                            disabled={busy || host.credentialRenewalRequestedAt !== undefined}
                            onSelect={() => onRenew(host)}
                          >
                            {host.credentialRenewalRequestedAt
                              ? t("hostCredentialRenewalPending")
                              : t("hostCredentialRenewNow")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          className="text-destructive"
                          data-testid={`host-admin-revoke-${host.id}`}
                          disabled={busy}
                          onSelect={() => onRevoke(host)}
                        >
                          {t("hostAdminRevoke")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {expiryState === "expired" ||
                  expiryState === "expiring" ||
                  host.credentialRenewalRequestedAt ? (
                    <span
                      className="col-span-4 text-xs text-amber-700 dark:text-amber-300"
                      data-testid={`host-credential-expiry-${host.id}`}
                    >
                      {host.credentialRenewalRequestedAt
                        ? t("hostCredentialRenewalPending")
                        : t(`hostCredentialExpiry_${expiryState}`).replace(
                            "{expiry}",
                            host.credentialExpiresAt
                              ? formatDate(host.credentialExpiresAt, locale)
                              : ""
                          )}
                    </span>
                  ) : null}
                  <ManagementDialog
                    open={selectedHostId === host.id}
                    onOpenChange={(open) => {
                      if (!open) setSelectedHostId(null);
                    }}
                    title={host.displayName}
                    t={t}
                  >
                    <div className="flex flex-col gap-4 text-sm">
                      <p>{t(`hostAvailability_${reason}`)}</p>
                      <p className="text-text-muted">
                        {agents.join(" · ") || t("hostAvailabilityNoAgents")}
                      </p>
                      <p className="text-text-muted">
                        {host.credentialExpiresAt
                          ? t(`hostCredentialExpiry_${expiryState}`).replace(
                              "{expiry}",
                              formatDate(host.credentialExpiresAt, locale)
                            )
                          : t("hostCredentialExpiry_legacy")}
                      </p>
                      {host.credentialRenewalRequestedAt ? (
                        <p
                          data-testid={`host-credential-renewal-pending-${host.id}`}
                          className="text-amber-700"
                        >
                          {t("hostCredentialRenewalPending")}
                        </p>
                      ) : null}
                      {reason !== "ready" ? (
                        <p className="text-text-muted">{t(`hostAvailabilityAction_${reason}`)}</p>
                      ) : null}
                    </div>
                  </ManagementDialog>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
