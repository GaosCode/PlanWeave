export type RendererPlatform = "darwin" | "win32" | "generic";

type RendererNavigator = {
  platform?: string;
  userAgent?: string;
  userAgentData?: {
    platform?: string;
  };
};

export function detectRendererPlatform(
  navigatorLike: RendererNavigator | undefined = globalThis.navigator
): RendererPlatform {
  const platformText = [
    navigatorLike?.userAgentData?.platform,
    navigatorLike?.platform,
    navigatorLike?.userAgent
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (platformText.includes("mac") || platformText.includes("darwin")) {
    return "darwin";
  }
  if (platformText.includes("win")) {
    return "win32";
  }
  return "generic";
}
