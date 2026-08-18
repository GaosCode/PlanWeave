import type { ReactNode, RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../i18n";

type CollaborationSetupHandoffFieldsProps = {
  formId: string;
  t: ReturnType<typeof createTranslator>;
  handoffInputRef: RefObject<HTMLTextAreaElement | null>;
  setupCodeInputRef: RefObject<HTMLInputElement | null>;
  displayName: string;
  manualOpen: boolean;
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
  onDisplayNameChange: (value: string) => void;
  onManualOpenChange: (open: boolean) => void;
  onServerBaseUrlChange: (value: string) => void;
  onAllowInsecureTransportChange: (allow: boolean) => void;
  /** Primary action immediately after the paste field. */
  action?: ReactNode;
};

/** Complete setup handoff first; protocol fields remain available as a recovery path. */
export function CollaborationSetupHandoffFields({
  formId,
  t,
  handoffInputRef,
  setupCodeInputRef,
  displayName,
  manualOpen,
  serverBaseUrl,
  allowInsecureTransport,
  onDisplayNameChange,
  onManualOpenChange,
  onServerBaseUrlChange,
  onAllowInsecureTransportChange,
  action
}: CollaborationSetupHandoffFieldsProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${formId}-setup-details`}>{t("peopleSetupDetails")}</Label>
        <Textarea
          id={`${formId}-setup-details`}
          data-testid="people-connect-setup-details"
          ref={handoffInputRef}
          className="min-h-36 resize-y font-mono text-xs"
          placeholder={t("peopleSetupDetailsPlaceholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs leading-5 text-muted-foreground">{t("peopleSetupDetailsHint")}</p>
      </div>

      {action}

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="w-fit px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-text-strong"
        data-testid="people-connect-setup-manual-toggle"
        aria-expanded={manualOpen}
        onClick={() => onManualOpenChange(!manualOpen)}
      >
        {manualOpen ? (
          <ChevronUpIcon className="mr-1 size-3.5" aria-hidden="true" />
        ) : (
          <ChevronDownIcon className="mr-1 size-3.5" aria-hidden="true" />
        )}
        {t(manualOpen ? "peopleHideAdvancedSetupDetails" : "peopleAdvancedSetupDetails")}
      </Button>

      {manualOpen ? (
        <div
          className="grid grid-cols-1 gap-x-5 gap-y-3 border-l-2 border-border/70 pl-4 md:grid-cols-2"
          data-testid="people-connect-setup-manual-fields"
        >
          <div className="flex flex-col gap-1 md:col-span-2">
            <Label htmlFor={`${formId}-name`}>{t("peopleDisplayName")}</Label>
            <Input
              id={`${formId}-name`}
              data-testid="people-connect-display-name"
              value={displayName}
              onChange={(event) => onDisplayNameChange(event.target.value)}
              autoComplete="nickname"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${formId}-url`}>{t("peopleServerUrl")}</Label>
            <Input
              id={`${formId}-url`}
              data-testid="people-connect-server-url"
              value={serverBaseUrl}
              onChange={(event) => onServerBaseUrlChange(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${formId}-setup`}>{t("peopleSetupCode")}</Label>
            <Input
              id={`${formId}-setup`}
              data-testid="people-connect-setup-code"
              ref={setupCodeInputRef}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
            <input
              type="checkbox"
              data-testid="people-connect-allow-insecure"
              checked={allowInsecureTransport}
              onChange={(event) => onAllowInsecureTransportChange(event.target.checked)}
            />
            {t("peopleAllowInsecureTransport")}
          </label>
        </div>
      ) : null}
    </div>
  );
}
