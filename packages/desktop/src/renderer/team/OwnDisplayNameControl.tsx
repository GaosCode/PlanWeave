import { useState } from "react";
import { humanDisplayNameSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

type OwnDisplayNameControlProps = {
  displayName: string;
  actionBusy: boolean;
  t: ReturnType<typeof createTranslator>;
  onUpdate: (displayName: string) => Promise<boolean>;
  showYouLabel?: boolean;
};

export function OwnDisplayNameControl({
  displayName,
  actionBusy,
  t,
  onUpdate,
  showYouLabel = true
}: OwnDisplayNameControlProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const parsedDraft = humanDisplayNameSchema.safeParse(draft);

  const cancel = () => {
    setDraft(displayName);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <div className="truncate text-sm font-semibold text-text-strong">
          {displayName}
          {showYouLabel ? (
            <span className="ml-1 text-muted-foreground">({t("peopleYou")})</span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          aria-label={t("peopleEditOwnName")}
          data-testid="people-edit-own-name"
          disabled={actionBusy}
          onClick={() => {
            setDraft(displayName);
            setEditing(true);
          }}
        >
          {t("peopleEditOwnName")}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-testid="people-own-name-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsedDraft.success) return;
        void onUpdate(parsedDraft.data).then((saved) => {
          if (saved) setEditing(false);
        });
      }}
    >
      <input
        type="text"
        value={draft}
        maxLength={128}
        aria-label={t("peopleEditOwnNameInput")}
        data-testid="people-own-name-input"
        className="h-8 min-w-40 flex-1 rounded-md border border-input bg-background px-2.5 text-sm text-text-strong outline-none focus-visible:ring-2 focus-visible:ring-ring"
        disabled={actionBusy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      />
      <Button
        type="submit"
        size="sm"
        className="h-8 px-2 text-xs"
        data-testid="people-save-own-name"
        disabled={actionBusy || !parsedDraft.success || parsedDraft.data === displayName}
      >
        {t("peopleSaveOwnName")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2 text-xs"
        data-testid="people-cancel-own-name"
        disabled={actionBusy}
        onClick={cancel}
      >
        {t("peopleCancelOwnName")}
      </Button>
    </form>
  );
}
