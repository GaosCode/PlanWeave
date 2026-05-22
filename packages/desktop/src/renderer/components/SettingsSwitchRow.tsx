import type { ReactNode } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

type SettingsSwitchRowProps = {
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
};

export function SettingsSwitchRow({ checked, description, disabled = false, onCheckedChange, title }: SettingsSwitchRowProps) {
  return (
    <Field data-disabled={disabled} orientation="horizontal" className="items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0">
      <FieldContent>
        <FieldLabel className="text-sm font-semibold">{title}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch aria-label={title} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </Field>
  );
}
