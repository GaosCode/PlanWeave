import { describe, expect, it } from "vitest";
import { formatAgentEndpointFleetCatalogError } from "../renderer/collaboration/formatAgentEndpointFleetCatalogError";
import { createTranslator } from "../renderer/i18n";

describe("formatAgentEndpointFleetCatalogError", () => {
  it("does not render optional Owner Fleet setup state as a task-card error", () => {
    const t = createTranslator("en");
    expect(formatAgentEndpointFleetCatalogError("operator_credential_missing", t)).toBeNull();
    expect(formatAgentEndpointFleetCatalogError("operator_profile_not_active", t)).toBeNull();
    expect(formatAgentEndpointFleetCatalogError("operator_profile_not_found", t)).toBeNull();
    expect(formatAgentEndpointFleetCatalogError("operator_bridge_unavailable", t)).toBeNull();
  });

  it("surfaces http transport failures so an empty fleet picker is not silent", () => {
    const t = createTranslator("en");
    const message = formatAgentEndpointFleetCatalogError("http_502", t);
    expect(message).toContain("http_502");
    expect(message.length).toBeGreaterThan(0);
  });

  it("surfaces local server not-ready with dedicated copy", () => {
    const t = createTranslator("en");
    const message = formatAgentEndpointFleetCatalogError("operator_local_server_not_ready", t);
    expect(message).toContain("still starting");
    expect(message).toContain("operator_local_server_not_ready");
  });

  it("surfaces a missing human principal as an explicit catalog error", () => {
    const t = createTranslator("en");
    const message = formatAgentEndpointFleetCatalogError("human_principal_unavailable", t);
    expect(message).toContain("signed-in person");
    expect(message).toContain("human_principal_unavailable");
  });
});
