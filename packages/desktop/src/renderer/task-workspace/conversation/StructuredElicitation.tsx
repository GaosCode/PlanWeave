import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { createTranslator } from "../../i18n";

type ElicitationField = {
  kind: "boolean" | "number" | "string";
  label: string;
  name: string;
  required: boolean;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function elicitationFields(schema: unknown): ElicitationField[] | null {
  const root = objectValue(schema);
  const properties = objectValue(root?.properties);
  if (!root || root.type !== "object" || !properties) return null;
  const required = Array.isArray(root.required)
    ? new Set(root.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  const fields: ElicitationField[] = [];
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = objectValue(rawProperty);
    if (!property || !["boolean", "integer", "number", "string"].includes(String(property.type))) {
      return null;
    }
    const kind =
      property.type === "boolean"
        ? "boolean"
        : property.type === "integer" || property.type === "number"
          ? "number"
          : "string";
    fields.push({
      kind,
      label: typeof property.title === "string" && property.title.trim() ? property.title : name,
      name,
      required: required.has(name)
    });
  }
  return fields;
}

export function StructuredElicitation({
  disabled,
  onCancel,
  onSubmit,
  schema,
  t
}: {
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (content: Record<string, string | number | boolean>) => void;
  schema: unknown;
  t: ReturnType<typeof createTranslator>;
}) {
  const fields = useMemo(() => elicitationFields(schema), [schema]);
  const formId = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  if (!fields) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("taskWorkspaceStructuredRequestUnsupported")}
        </p>
        <Button disabled={disabled} onClick={onCancel} size="sm" type="button" variant="outline">
          {t("acpCancelElicitation")}
        </Button>
      </div>
    );
  }
  const submit = () => {
    const content: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.required && (value === undefined || value === "")) {
        setError(t("taskWorkspaceFieldRequired").replace("{field}", field.label));
        return;
      }
      if (value === undefined || value === "") continue;
      if (field.kind === "number") {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          setError(t("taskWorkspaceFieldNumber").replace("{field}", field.label));
          return;
        }
        content[field.name] = number;
      } else {
        content[field.name] = value;
      }
    }
    setError(null);
    onSubmit(content);
  };
  return (
    <div className="space-y-3">
      {fields.map((field) => (
        <label className="grid gap-1 text-xs" htmlFor={`${formId}-${field.name}`} key={field.name}>
          <span className="font-medium">
            {field.label}
            {field.required ? " *" : ""}
          </span>
          {field.kind === "boolean" ? (
            <input
              id={`${formId}-${field.name}`}
              checked={values[field.name] === true}
              className="size-4"
              disabled={disabled}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.checked }))
              }
              type="checkbox"
            />
          ) : (
            <Input
              id={`${formId}-${field.name}`}
              disabled={disabled}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
              type={field.kind === "number" ? "number" : "text"}
              value={typeof values[field.name] === "string" ? String(values[field.name]) : ""}
            />
          )}
        </label>
      ))}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button disabled={disabled} onClick={submit} size="sm" type="button">
          {disabled ? t("acpActionPending") : t("acpSubmitElicitation")}
        </Button>
        <Button disabled={disabled} onClick={onCancel} size="sm" type="button" variant="outline">
          {t("acpCancelElicitation")}
        </Button>
      </div>
    </div>
  );
}
