import type { ReactNode } from "react";
import { SendIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../../i18n";

export function AcpComposerSurface({
  accessory,
  children,
  draft,
  onDraftChange,
  disabled,
  available,
  unavailableReason,
  onSubmit,
  onCancel,
  cancelLabel,
  cancelling,
  error,
  t
}: {
  accessory?: ReactNode;
  children?: ReactNode;
  draft: string;
  onDraftChange: (value: string) => void;
  disabled: boolean;
  available: boolean;
  unavailableReason: string;
  onSubmit: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
  cancelling: boolean;
  error: string | null;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section
      className="pointer-events-auto w-full px-5 pt-2 pb-4"
      data-testid="task-workspace-composer"
    >
      <div
        className="relative z-10 mx-auto w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-lg shadow-black/5"
        data-testid="task-workspace-composer-surface"
      >
        {children}
        <Textarea
          aria-label={t("acpPromptLabel")}
          className="min-h-20 max-h-40 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          disabled={disabled}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={available ? t("acpPromptPlaceholder") : unavailableReason}
          value={draft}
        />
        <div className="flex items-center justify-between gap-3 px-1 pt-1 text-[11px] text-muted-foreground">
          <span>{available ? t("acpPromptHint") : unavailableReason}</span>
          <div className="flex min-w-0 items-center gap-2">
            {accessory}
            <Button
              aria-label={onCancel ? (cancelLabel ?? t("acpCancelPromptTurn")) : t("acpSendPrompt")}
              disabled={onCancel ? cancelling : disabled || !draft.trim()}
              onClick={onCancel ?? onSubmit}
              size="icon-sm"
              type="button"
            >
              {onCancel ? <SquareIcon fill="currentColor" /> : <SendIcon />}
            </Button>
          </div>
        </div>
        {error ? (
          <p className="px-1 pt-1 text-xs text-destructive" role="alert">
            {t("acpPromptFailed")}: {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
