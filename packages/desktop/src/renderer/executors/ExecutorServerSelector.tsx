import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { OperatorProfileView } from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";
import { serverProfileLabel } from "../settings/serverProfileLabel";

/** The endpoint identifies the Server; a saved operator profile name can outlive a deployment move. */
export function ExecutorServerSelector({
  profiles,
  activeProfile,
  busy,
  onSelect,
  t
}: {
  profiles: readonly OperatorProfileView[];
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  onSelect: (profileId: string) => Promise<boolean>;
  t: ReturnType<typeof createTranslator>;
}) {
  if (profiles.length === 0) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3" data-testid="executors-server-source">
      <span className="text-xs text-text-muted">{t("executorsServerSource")}</span>
      <Select
        value={activeProfile?.profileId ?? ""}
        disabled={busy}
        onValueChange={(id) => {
          if (id !== activeProfile?.profileId) void onSelect(id);
        }}
      >
        <SelectTrigger
          className="w-auto max-w-full min-w-64"
          aria-label={t("executorServerSelector")}
        >
          <SelectValue placeholder={t("executorServerSelector")}>
            {activeProfile ? serverProfileLabel(activeProfile, t) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-80">
          {profiles.map((profile) => (
            <SelectItem
              key={profile.profileId}
              value={profile.profileId}
              textValue={serverProfileLabel(profile, t)}
            >
              <span className="flex min-w-0 flex-col gap-1 py-1">
                <span className="font-medium">{serverProfileLabel(profile, t)}</span>
                <span className="text-xs text-text-muted">
                  {new URL(profile.serverBaseUrl).origin}
                </span>
                {profiles.some(
                  (other) =>
                    other.profileId !== profile.profileId &&
                    new URL(other.serverBaseUrl).origin === new URL(profile.serverBaseUrl).origin
                ) ? (
                  <span className="text-xs text-text-muted">
                    {profile.displayName} · {profile.profileId.slice(-6)}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
