import type {
  CanvasPersonAccessView,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import type { createTranslator } from "../i18n";

export function accessRoleLabel(
  role: CurrentCanvasAccessView["canvas"]["effectiveRole"],
  t: ReturnType<typeof createTranslator>
) {
  if (role === "owner") return t("accessRoleOwner");
  if (role === "editor") return t("accessRoleEditor");
  if (role === "viewer") return t("accessRoleViewer");
  return t("accessRoleNone");
}

/** Present the grants supplied by the Server; effective access is never calculated here. */
export function personAccessSource(
  person: CanvasPersonAccessView,
  t: ReturnType<typeof createTranslator>
) {
  if (!person.effectiveRole) return t("accessRoleNone");
  if (person.effectiveRole === "owner") return t("accessSourceOwner");
  const sources = [];
  if (person.grants.some((grant) => grant.scopeKind === "project"))
    sources.push(t("accessSourceProject"));
  if (person.grants.some((grant) => grant.scopeKind === "canvas"))
    sources.push(t("accessSourceCanvas"));
  return sources.length ? sources.join(" · ") : t("accessSourceShared");
}
