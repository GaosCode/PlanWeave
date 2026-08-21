import type { ReactNode } from "react";

export function WorkspaceSectionHeader({
  title,
  description,
  titleId,
  toggle,
  action
}: {
  title: string;
  description: string;
  titleId: string;
  toggle?: {
    expanded: boolean;
    onToggle: () => void;
    indicator: ReactNode;
    label: string;
    testId?: string;
  };
  action?: ReactNode;
}) {
  if (toggle) {
    const descriptionId = `${titleId}-description`;

    return (
      <div className="flex min-w-0 items-start justify-between gap-5">
        <div className="group relative min-w-0 flex-1 rounded-md py-1.5">
          <button
            type="button"
            className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={toggle.expanded}
            aria-label={toggle.label}
            aria-describedby={descriptionId}
            data-testid={toggle.testId}
            onClick={toggle.onToggle}
          />
          <div className="pointer-events-none relative flex min-w-0 items-start justify-between gap-5">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-base font-semibold text-text-strong">
                {title}
              </h2>
              <p id={descriptionId} className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">
                {description}
              </p>
            </div>
            <span className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-text-strong">
              {toggle.indicator}
            </span>
          </div>
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-start justify-between gap-5">
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-base font-semibold text-text-strong">
          {title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text-muted">{description}</p>
      </div>
      {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
    </div>
  );
}
