import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { agentEndpointDisplayLabel, type AvailableAgentEndpoint } from "./agentEndpointViewModel";

export const inheritAgentEndpointValue = "__inherit_agent_endpoint";

export function AgentEndpointSelect({
  ariaLabel,
  disabled = false,
  endpoints,
  inheritLabel,
  onValueChange,
  selectedEndpointId,
  selectedUnknownLabel,
  unavailableLabel,
  unavailableReasonLabel,
  triggerClassName
}: {
  ariaLabel: string;
  disabled?: boolean;
  endpoints: readonly AvailableAgentEndpoint[];
  inheritLabel?: string;
  onValueChange: (endpointId: string) => void;
  selectedEndpointId: string;
  selectedUnknownLabel?: string;
  unavailableLabel: string;
  unavailableReasonLabel?: (reason: string | null) => string;
  triggerClassName?: string;
}) {
  const selectedKnown =
    selectedEndpointId === inheritAgentEndpointValue ||
    endpoints.some((endpoint) => endpoint.id === selectedEndpointId);
  // Preserve catalog order: locals first, then remotes in host enrollment / list order.
  const localEndpoints = endpoints.filter((endpoint) => endpoint.source === "local");
  const remoteEndpoints = endpoints.filter((endpoint) => endpoint.source === "remote");
  const renderEndpointItem = (endpoint: AvailableAgentEndpoint) => (
    <SelectItem disabled={!endpoint.available} key={endpoint.id} value={endpoint.id}>
      <span className="flex min-w-0 items-center gap-2">
        <span>{agentEndpointDisplayLabel(endpoint)}</span>
        {!endpoint.available ? (
          <span className="text-xs text-muted-foreground">
            {unavailableReasonLabel?.(endpoint.unavailableReason) ?? unavailableLabel}
          </span>
        ) : null}
      </span>
    </SelectItem>
  );

  return (
    <Select disabled={disabled} onValueChange={onValueChange} value={selectedEndpointId}>
      <SelectTrigger
        aria-label={ariaLabel}
        className={triggerClassName}
        onClick={(event) => event.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      {/*
        Popper keeps the panel anchored while scrolling (no item-aligned drift).
        showScrollDownHint: bottom cue only — never the top scroll button.
      */}
      <SelectContent
        align="start"
        className="!max-h-56 min-w-48"
        position="popper"
        showScrollDownHint
        sideOffset={4}
      >
        <SelectGroup>
          {inheritLabel ? (
            <SelectItem value={inheritAgentEndpointValue}>{inheritLabel}</SelectItem>
          ) : null}
          {!selectedKnown ? (
            <SelectItem disabled value={selectedEndpointId}>
              {selectedUnknownLabel ?? unavailableLabel}
            </SelectItem>
          ) : null}
          {localEndpoints.map(renderEndpointItem)}
          {localEndpoints.length > 0 && remoteEndpoints.length > 0 ? <SelectSeparator /> : null}
          {remoteEndpoints.map(renderEndpointItem)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
