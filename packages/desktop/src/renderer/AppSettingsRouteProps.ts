import type { ComponentProps } from "react";
import type { AppSettingsRoute } from "./AppSettingsRoute";

type AppSettingsRouteProps = ComponentProps<typeof AppSettingsRoute>;

export function buildAppSettingsRouteProps(props: AppSettingsRouteProps): AppSettingsRouteProps {
  return props;
}
