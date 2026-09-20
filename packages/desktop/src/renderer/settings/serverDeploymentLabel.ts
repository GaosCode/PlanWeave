import type { DeploymentEndpoint } from "@planweave-ai/collaboration-protocol/connection";
import type { createTranslator } from "../i18n";

export function serverDeploymentLabel(
  endpoint: DeploymentEndpoint,
  t: ReturnType<typeof createTranslator>
): string {
  const url = new URL(endpoint.serverOrigin);
  if (url.protocol === "https:" && url.hostname.endsWith(".ts.net")) {
    return t("serverDeploymentTailscale");
  }
  switch (endpoint.topology) {
    case "loopback_http":
      return t("deploymentLoopback");
    case "loopback_https":
      return t("deploymentLoopbackHttps");
    case "lan_http":
      return t("deploymentLanAdvanced");
    case "private_https":
      return t("deploymentPrivateHttpsTopology");
    case "public_https":
      return "HTTPS";
  }
}
