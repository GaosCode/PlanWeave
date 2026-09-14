import type { AcpPermissionOption } from "@planweave-ai/agent-host-protocol/browser";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";

const scopeLabels = {
  allow_once: "acpPermissionAllowOnce",
  allow_always: "acpPermissionAllowAlways",
  reject_once: "acpPermissionRejectOnce",
  reject_always: "acpPermissionRejectAlways"
} as const;

export function AcpPermissionChoices({
  options,
  disabled,
  onSelect,
  onCancel,
  t
}: {
  options: readonly AcpPermissionOption[];
  disabled: boolean;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Button
          key={option.optionId}
          type="button"
          size="sm"
          variant={option.kind.startsWith("reject_") ? "outline" : "secondary"}
          disabled={disabled}
          data-testid="acp-permission-option"
          data-option-id={option.optionId}
          data-option-kind={option.kind}
          onClick={() => onSelect(option.optionId)}
        >
          {option.label} — {t(scopeLabels[option.kind])}
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        data-testid="acp-permission-cancel"
        onClick={onCancel}
      >
        {t("acpCancelPermission")}
      </Button>
    </div>
  );
}
