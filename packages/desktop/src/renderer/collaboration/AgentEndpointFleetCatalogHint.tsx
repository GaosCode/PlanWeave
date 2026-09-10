export function AgentEndpointFleetCatalogHint({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p
      className="max-w-72 px-2 py-1.5 text-xs leading-relaxed text-muted-foreground"
      data-testid="agent-endpoint-fleet-catalog-error"
      role="status"
    >
      {message}
    </p>
  );
}
