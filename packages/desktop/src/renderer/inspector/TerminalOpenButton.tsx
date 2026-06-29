import type {
  DesktopCanvasReference,
  DesktopRunTerminalAvailability,
  DesktopRunTerminalUnavailableReason,
  DesktopTerminalAppDetection,
  DesktopTerminalAppId
} from "@planweave-ai/runtime";
import { CheckIcon, ChevronDownIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { createTranslator } from "../i18n";

type TerminalOpenButtonProps = {
  canvasRef?: DesktopCanvasReference | null;
  className?: string;
  defaultTerminalAppId: DesktopTerminalAppId | null;
  label?: string;
  missingSessionReason?: string;
  onOpenTerminal?: (recordId: string | null, appId: DesktopTerminalAppId) => Promise<void>;
  onOpenRunTerminal?: (recordId: string, appId: DesktopTerminalAppId) => Promise<void>;
  onTerminalDefaultAppChange?: (appId: DesktopTerminalAppId) => Promise<void> | void;
  recordId?: string | null;
  terminalAvailability?: DesktopRunTerminalAvailability | null;
  terminalApps: DesktopTerminalAppDetection[];
  tmuxAvailable: boolean;
  t: ReturnType<typeof createTranslator>;
};

function TerminalAppIcon({ app }: { app: DesktopTerminalAppDetection | null }) {
  if (app?.iconDataUrl) {
    return <img alt="" className="size-4 shrink-0 rounded-[3px]" src={app.iconDataUrl} />;
  }
  return <TerminalIcon data-icon="inline-start" />;
}

function terminalAvailabilityDescription(
  reason: DesktopRunTerminalUnavailableReason | null | undefined,
  missingSessionReason: string | undefined,
  t: ReturnType<typeof createTranslator>
): string {
  if (reason === "no_tmux_session") {
    return missingSessionReason ?? t("tmuxTerminalNoSession");
  }
  if (reason === "tmux_unavailable") {
    return t("tmuxTerminalTmuxUnavailable");
  }
  if (reason === "tmux_session_not_running") {
    return t("tmuxTerminalSessionNotRunning");
  }
  if (reason === "record_unavailable") {
    return t("tmuxTerminalRecordUnavailable");
  }
  return missingSessionReason ?? t("tmuxTerminalSessionStatusUnavailable");
}

function terminalDisabledReason({
  canAttachTmux,
  canvasRef,
  onOpenTerminal,
  onOpenRunTerminal,
  terminalApps,
  t
}: Pick<
  TerminalOpenButtonProps,
  "canvasRef" | "onOpenTerminal" | "onOpenRunTerminal" | "terminalApps" | "t"
> & { canAttachTmux: boolean }): string | null {
  if (!canvasRef) {
    return t("tmuxTerminalCanvasUnavailable");
  }
  if (canAttachTmux ? !onOpenRunTerminal : !onOpenTerminal) {
    return t("tmuxTerminalBridgeUnavailable");
  }
  if (!terminalApps.some((app) => app.available)) {
    return t("tmuxTerminalAppsUnavailable");
  }
  return null;
}

export function TerminalOpenButton({
  canvasRef,
  className,
  defaultTerminalAppId,
  label,
  missingSessionReason,
  onOpenTerminal,
  onOpenRunTerminal,
  onTerminalDefaultAppChange,
  recordId,
  terminalAvailability,
  terminalApps,
  tmuxAvailable,
  t
}: TerminalOpenButtonProps) {
  const normalizedTerminalApps = Array.isArray(terminalApps) ? terminalApps : [];
  const availableApps = normalizedTerminalApps.filter((app) => app.available);
  const defaultAvailableApp = availableApps.find((app) => app.appId === defaultTerminalAppId) ?? availableApps[0] ?? null;
  const canAttachTmux = Boolean(terminalAvailability?.available && recordId && onOpenRunTerminal && tmuxAvailable);
  const actionLabel = canAttachTmux ? t("openTmuxTerminal") : t("openTerminal");
  const availabilityDescription = canAttachTmux ? null : terminalAvailabilityDescription(terminalAvailability?.unavailableReason, missingSessionReason, t);
  const disabledReason = terminalDisabledReason({
    canAttachTmux,
    canvasRef,
    onOpenTerminal,
    onOpenRunTerminal,
    terminalApps: normalizedTerminalApps,
    t
  });
  const disabled = Boolean(disabledReason);
  const title = disabledReason ?? (defaultAvailableApp ? `${actionLabel}: ${defaultAvailableApp.label}${availabilityDescription ? ` - ${availabilityDescription}` : ""}` : actionLabel);
  const ariaLabel = disabledReason ?? label ?? actionLabel;
  const buttonLabel = label ?? null;

  const openWithApp = async (appId: DesktopTerminalAppId) => {
    if (disabled) {
      return;
    }
    await onTerminalDefaultAppChange?.(appId);
    if (canAttachTmux && recordId && onOpenRunTerminal) {
      await onOpenRunTerminal(recordId, appId);
      return;
    }
    await onOpenTerminal?.(recordId ?? null, appId);
  };

  return (
    <div className={cn("inline-flex items-center", className)}>
      <Button
        aria-label={ariaLabel}
        className={cn(label ? "rounded-r-md" : "rounded-r-none")}
        disabled={disabled}
        onClick={() => {
          if (defaultAvailableApp) {
            void openWithApp(defaultAvailableApp.appId);
          }
        }}
        size={label ? "sm" : "icon-sm"}
        title={title}
        type="button"
        variant={label ? "outline" : "ghost"}
      >
        <TerminalAppIcon app={defaultAvailableApp} />
        {buttonLabel ? <span className="min-w-0 truncate">{buttonLabel}</span> : null}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={disabledReason ?? t("chooseTerminalApp")}
            className={cn(label ? "ml-1" : "rounded-l-none border-l border-border/70 px-1")}
            disabled={disabled}
            size="icon-sm"
            title={disabledReason ?? t("chooseTerminalApp")}
            type="button"
            variant={label ? "ghost" : "ghost"}
          >
            <ChevronDownIcon data-icon="inline-start" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t("chooseTerminalApp")}</DropdownMenuLabel>
          {normalizedTerminalApps.map((app) => (
            <DropdownMenuItem
              disabled={!app.available}
              key={app.appId}
              onSelect={() => {
                if (app.available) {
                  void openWithApp(app.appId);
                }
              }}
              title={app.unavailableReason ?? undefined}
            >
              <TerminalAppIcon app={app} />
              <span className="min-w-0 flex-1 truncate">{app.label}</span>
              {app.available ? null : <span className="max-w-24 truncate text-xs text-muted-foreground">{app.unavailableReason ?? t("unavailable")}</span>}
              {app.appId === defaultTerminalAppId ? <CheckIcon className="ml-auto" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
