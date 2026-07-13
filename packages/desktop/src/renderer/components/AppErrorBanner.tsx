import { AlertTriangleIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type AppErrorBannerProps = {
  message: string | null;
  onDismiss: () => void;
  t: ReturnType<typeof createTranslator>;
};

export function AppErrorBanner({ message, onDismiss, t }: AppErrorBannerProps) {
  if (!message) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute top-12 left-1/2 z-50 w-[min(720px,calc(100%-2rem))] -translate-x-1/2">
      <div className="pointer-events-auto flex items-start gap-3 rounded-lg border border-destructive/40 bg-background p-3 text-sm shadow-lg animate-in fade-in slide-in-from-top-2 duration-[var(--motion-duration-base)] ease-[var(--motion-ease-standard)]" role="alert">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap text-destructive">{message}</div>
        <Button size="icon-sm" variant="ghost" aria-label={t("dismissError")} onClick={onDismiss}>
          <XIcon data-icon="inline-start" />
        </Button>
      </div>
    </div>
  );
}
