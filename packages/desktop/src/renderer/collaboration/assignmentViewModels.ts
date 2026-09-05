import type {
  AssignmentAvailability,
  AssignmentDisplayProjection,
  AssignmentTarget,
  EligibleAssigneesResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import type {
  HumanPrincipalId,
  WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type {
  CollaborationBoundaryErrorView,
  CollaborationMutationRecord,
  CollaborationSyncPhase,
  CollaborationMemberSummary
} from "../../shared/collaborationReadModels.js";
import type { CollaborationSessionPhase, CollaborationStatus } from "../../shared/collaboration.js";
import { memberInitials } from "./peopleViewModels.js";
import { workItemKey } from "../../shared/collaborationReadModels.js";

/** Why an option is not selectable, or why edit is blocked. */
export type AssigneeUnavailableReason =
  | "task_disallows_machine"
  | "host_missing"
  | "host_revoked"
  | "host_not_authorized"
  | "host_capability_mismatch"
  | "host_offline"
  | "host_at_capacity"
  | "human_membership_inactive"
  | "role_insufficient"
  | "not_connected"
  | "offline"
  | "submitting"
  | "stale_conflict"
  | "work_item_missing"
  | "forbidden"
  | "auth_expired"
  | "server_error";

/**
 * Localized copy for primary assignee labels and secondary host/membership hints.
 * Production callers should build this from the i18n catalog (en + zh-CN parity).
 */
export type AssigneeDisplayLabels = {
  unassigned: string;
  automaticHost: string;
  automaticHostSelection: string;
  automaticHostSecondary: string;
  inactiveMembership: string;
  hostOffline: string;
  hostAtCapacity: string;
  agentHost: string;
  host: string;
  taskDisallowsMachine: string;
};

/** English defaults for pure unit tests; UI must pass catalog-backed labels. */
export const DEFAULT_ASSIGNEE_DISPLAY_LABELS: AssigneeDisplayLabels = {
  unassigned: "Unassigned",
  automaticHost: "Automatic host",
  automaticHostSelection: "Automatic host selection",
  automaticHostSecondary: "Server chooses a compatible host at dispatch time",
  inactiveMembership: "Inactive membership",
  hostOffline: "Offline",
  hostAtCapacity: "At capacity",
  agentHost: "Agent Host",
  host: "Host",
  taskDisallowsMachine: "Tasks cannot be assigned to Agent Hosts."
};

export function assigneeDisplayLabelsFromTranslator(
  t: (
    key:
      | "assigneeLabelUnassigned"
      | "assigneeLabelAutomaticHost"
      | "assigneeLabelAutomaticHostSelection"
      | "assigneeSecondaryAutomaticHost"
      | "assigneeSecondaryInactiveMembership"
      | "assigneeSecondaryHostOffline"
      | "assigneeSecondaryHostAtCapacity"
      | "assigneeSecondaryAgentHost"
      | "assigneeSecondaryHost"
      | "assigneeReasonTaskNoMachine"
  ) => string
): AssigneeDisplayLabels {
  return {
    unassigned: t("assigneeLabelUnassigned"),
    automaticHost: t("assigneeLabelAutomaticHost"),
    automaticHostSelection: t("assigneeLabelAutomaticHostSelection"),
    automaticHostSecondary: t("assigneeSecondaryAutomaticHost"),
    inactiveMembership: t("assigneeSecondaryInactiveMembership"),
    hostOffline: t("assigneeSecondaryHostOffline"),
    hostAtCapacity: t("assigneeSecondaryHostAtCapacity"),
    agentHost: t("assigneeSecondaryAgentHost"),
    host: t("assigneeSecondaryHost"),
    taskDisallowsMachine: t("assigneeReasonTaskNoMachine")
  };
}

export type AssigneeOptionKind = AssignmentTarget["kind"];

export type AssigneeOption = {
  id: string;
  kind: AssigneeOptionKind;
  target: AssignmentTarget;
  label: string;
  secondaryLabel: string | null;
  selectable: boolean;
  unavailableReason: AssigneeUnavailableReason | null;
  selected: boolean;
  searchText: string;
  /** Soft availability warning that does not block selection (offline/capacity). */
  warningReason: Extract<AssigneeUnavailableReason, "host_offline" | "host_at_capacity"> | null;
};

export type AssigneeSectionId = "unassigned" | "people" | "hosts" | "automatic";

export type AssigneeSection = {
  id: AssigneeSectionId;
  options: AssigneeOption[];
};

export type AssigneeCurrentDisplay = {
  label: string;
  targetKind: AssignmentTarget["kind"];
  revision: number;
  availabilityStatus: AssignmentAvailability["status"];
  availabilityReason: AssignmentAvailability["reason"];
  /** Explicit human/host degradation copy source. */
  issueReason: AssigneeUnavailableReason | null;
  humanPrincipalId: string | null;
  hostId: string | null;
  initials: string | null;
};

export type AssigneePickerMode =
  | "disconnected"
  | "connecting"
  | "loading"
  | "ready"
  | "offline"
  | "forbidden"
  | "auth_expired"
  | "error"
  | "stale_conflict";

export type AssigneePickerViewModel = {
  mode: AssigneePickerMode;
  workItemKey: string;
  workItem: WorkItemRef;
  canEdit: boolean;
  editBlockedReason: AssigneeUnavailableReason | null;
  current: AssigneeCurrentDisplay;
  sections: AssigneeSection[];
  filteredOptions: AssigneeOption[];
  pending: boolean;
  lastError: string | null;
  expectedRevision: number;
  /** True when a conflict requires refresh/retry rather than optimistic overwrite. */
  staleConflict: boolean;
};

export function assignmentTargetKey(target: AssignmentTarget): string {
  switch (target.kind) {
    case "unassigned":
      return "unassigned";
    case "human":
      return `human:${target.humanPrincipalId}`;
    case "exact_host":
      return `exact_host:${target.hostId}`;
    case "automatic_host":
      return "automatic_host";
    default: {
      const _exhaustive: never = target;
      return String(_exhaustive);
    }
  }
}

export function targetsEqual(left: AssignmentTarget, right: AssignmentTarget): boolean {
  return assignmentTargetKey(left) === assignmentTargetKey(right);
}

export function resolveAssigneePickerMode(input: {
  status: CollaborationStatus | null;
  syncPhase: CollaborationSyncPhase;
  staleConflict: boolean;
  loading: boolean;
}): AssigneePickerMode {
  if (input.staleConflict || input.syncPhase === "stale_conflict") {
    return "stale_conflict";
  }
  const sessionPhase: CollaborationSessionPhase = input.status?.session.phase ?? "idle";
  if (sessionPhase === "connecting") return "connecting";
  if (sessionPhase === "error") {
    if (input.syncPhase === "auth_expired") return "auth_expired";
    if (input.syncPhase === "forbidden") return "forbidden";
    return "error";
  }
  if (sessionPhase !== "connected" && sessionPhase !== "ready") {
    return "disconnected";
  }
  if (input.syncPhase === "auth_expired") return "auth_expired";
  if (input.syncPhase === "forbidden") return "forbidden";
  if (input.syncPhase === "disconnected" || input.syncPhase === "reconnecting") return "offline";
  if (input.loading || input.syncPhase === "loading") return "loading";
  if (input.syncPhase === "error" || input.syncPhase === "degraded") return "error";
  return "ready";
}

export function canAssignWork(input: {
  status: CollaborationStatus | null;
  members: readonly CollaborationMemberSummary[];
}): boolean {
  const principalId =
    input.status?.profiles.find((profile) => profile.profileId === input.status?.activeProfileId)
      ?.humanPrincipalId ?? null;
  if (!principalId) return false;
  return input.members.some((member) => member.humanPrincipalId === principalId);
}

export function mapAvailabilityToIssue(
  availability: AssignmentAvailability | undefined | null
): AssigneeUnavailableReason | null {
  if (!availability) return null;
  switch (availability.reason) {
    case "ready":
    case "unassigned":
    case "automatic_pending_selection":
      return null;
    case "human_membership_inactive":
      return "human_membership_inactive";
    case "host_missing":
      return "host_missing";
    case "host_revoked":
      return "host_revoked";
    case "host_not_authorized":
      return "host_not_authorized";
    case "host_capability_mismatch":
      return "host_capability_mismatch";
    case "host_offline":
      return "host_offline";
    case "host_at_capacity":
      return "host_at_capacity";
    case "work_item_missing":
      return "work_item_missing";
    default:
      return null;
  }
}

export function buildAssigneeCurrentDisplay(
  assignment: AssignmentDisplayProjection | null | undefined,
  labels: AssigneeDisplayLabels = DEFAULT_ASSIGNEE_DISPLAY_LABELS
): AssigneeCurrentDisplay {
  if (!assignment) {
    return {
      label: labels.unassigned,
      targetKind: "unassigned",
      revision: 0,
      availabilityStatus: "unassigned",
      availabilityReason: "unassigned",
      issueReason: null,
      humanPrincipalId: null,
      hostId: null,
      initials: null
    };
  }

  const issueReason = mapAvailabilityToIssue(assignment.availability);
  switch (assignment.target.kind) {
    case "unassigned":
      return {
        label: labels.unassigned,
        targetKind: "unassigned",
        revision: assignment.revision,
        availabilityStatus: assignment.availability.status,
        availabilityReason: assignment.availability.reason,
        issueReason,
        humanPrincipalId: null,
        hostId: null,
        initials: null
      };
    case "human": {
      const name = assignment.human?.displayName?.trim() || assignment.target.humanPrincipalId;
      return {
        label: name,
        targetKind: "human",
        revision: assignment.revision,
        availabilityStatus: assignment.availability.status,
        availabilityReason: assignment.availability.reason,
        issueReason,
        humanPrincipalId: assignment.target.humanPrincipalId,
        hostId: null,
        initials: memberInitials(name)
      };
    }
    case "exact_host": {
      const name = assignment.host?.displayName?.trim() || assignment.target.hostId;
      return {
        label: name,
        targetKind: "exact_host",
        revision: assignment.revision,
        availabilityStatus: assignment.availability.status,
        availabilityReason: assignment.availability.reason,
        issueReason,
        humanPrincipalId: null,
        hostId: assignment.target.hostId,
        initials: null
      };
    }
    case "automatic_host":
      return {
        label: labels.automaticHost,
        targetKind: "automatic_host",
        revision: assignment.revision,
        availabilityStatus: assignment.availability.status,
        availabilityReason: assignment.availability.reason,
        issueReason,
        humanPrincipalId: null,
        hostId: null,
        initials: null
      };
    default: {
      const _exhaustive: never = assignment.target;
      return {
        label: String(_exhaustive),
        targetKind: "unassigned",
        revision: assignment.revision,
        availabilityStatus: assignment.availability.status,
        availabilityReason: assignment.availability.reason,
        issueReason,
        humanPrincipalId: null,
        hostId: null,
        initials: null
      };
    }
  }
}

function evaluateHumanOption(input: {
  humanPrincipalId: HumanPrincipalId;
  displayName: string;
  membershipActive: boolean;
  selected: boolean;
  labels: AssigneeDisplayLabels;
}): AssigneeOption {
  const target: AssignmentTarget = {
    kind: "human",
    humanPrincipalId: input.humanPrincipalId
  };
  const unavailableReason: AssigneeUnavailableReason | null = input.membershipActive
    ? null
    : "human_membership_inactive";
  return {
    id: assignmentTargetKey(target),
    kind: "human",
    target,
    label: input.displayName.trim() || input.humanPrincipalId,
    secondaryLabel: input.membershipActive ? null : input.labels.inactiveMembership,
    selectable: unavailableReason === null,
    unavailableReason,
    selected: input.selected,
    searchText: `${input.displayName} ${input.humanPrincipalId}`.toLowerCase(),
    warningReason: null
  };
}

/**
 * Build Task/Block assignee picker sections from authoritative projections + eligible list.
 * Responsibility and reviewer axes expose human principals only.
 */
export function buildAssigneeSections(input: {
  workItem: WorkItemRef;
  assignment: AssignmentDisplayProjection | null | undefined;
  members: readonly CollaborationMemberSummary[];
  eligible: EligibleAssigneesResponse | null | undefined;
  labels?: AssigneeDisplayLabels;
  authorityRole?: "responsibility" | "reviewer";
}): AssigneeSection[] {
  const labels = input.labels ?? DEFAULT_ASSIGNEE_DISPLAY_LABELS;
  const selected = input.assignment?.target ?? { kind: "unassigned" as const };

  const unassigned: AssigneeOption = {
    id: "unassigned",
    kind: "unassigned",
    target: { kind: "unassigned" },
    label: labels.unassigned,
    secondaryLabel: null,
    selectable: true,
    unavailableReason: null,
    selected: selected.kind === "unassigned",
    searchText: `${labels.unassigned} unassigned none clear`.toLowerCase(),
    warningReason: null
  };

  const humanById = new Map<string, AssigneeOption>();

  for (const member of input.members) {
    humanById.set(
      member.humanPrincipalId,
      evaluateHumanOption({
        humanPrincipalId: member.humanPrincipalId,
        displayName: member.displayName,
        membershipActive: true,
        selected:
          selected.kind === "human" && selected.humanPrincipalId === member.humanPrincipalId,
        labels
      })
    );
  }

  for (const human of input.eligible?.humans ?? []) {
    const existing = humanById.get(human.humanPrincipalId);
    if (existing && human.membershipActive) continue;
    humanById.set(
      human.humanPrincipalId,
      evaluateHumanOption({
        humanPrincipalId: human.humanPrincipalId,
        displayName: human.displayName?.trim() || existing?.label || human.humanPrincipalId,
        membershipActive: human.membershipActive,
        selected: selected.kind === "human" && selected.humanPrincipalId === human.humanPrincipalId,
        labels
      })
    );
  }

  // Current human assignment may no longer be in membership/eligible lists.
  if (selected.kind === "human" && !humanById.has(selected.humanPrincipalId)) {
    humanById.set(
      selected.humanPrincipalId,
      evaluateHumanOption({
        humanPrincipalId: selected.humanPrincipalId,
        displayName: input.assignment?.human?.displayName?.trim() || selected.humanPrincipalId,
        membershipActive: input.assignment?.human?.membershipActive ?? false,
        selected: true,
        labels
      })
    );
  }

  const people = [...humanById.values()].sort((left, right) =>
    left.label.localeCompare(right.label)
  );

  return [
    { id: "unassigned", options: [unassigned] },
    { id: "people", options: people }
  ];
}

export function filterAssigneeOptions(
  sections: readonly AssigneeSection[],
  query: string
): AssigneeOption[] {
  const normalized = query.trim().toLowerCase();
  const options = sections.flatMap((section) => section.options);
  if (!normalized) return options;
  return options.filter((option) => option.searchText.includes(normalized));
}

export function filterAssigneeSections(
  sections: readonly AssigneeSection[],
  query: string
): AssigneeSection[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized)
    return sections.map((section) => ({ ...section, options: [...section.options] }));
  return sections
    .map((section) => ({
      ...section,
      options: section.options.filter((option) => option.searchText.includes(normalized))
    }))
    .filter((section) => section.options.length > 0);
}

export function buildAssigneePickerViewModel(input: {
  workItem: WorkItemRef;
  assignment: AssignmentDisplayProjection | null | undefined;
  members: readonly CollaborationMemberSummary[];
  eligible: EligibleAssigneesResponse | null | undefined;
  status: CollaborationStatus | null;
  syncPhase: CollaborationSyncPhase;
  loading: boolean;
  pending: boolean;
  staleConflict: boolean;
  lastError: CollaborationBoundaryErrorView | string | null;
  query?: string;
  pendingMutations?: readonly CollaborationMutationRecord[];
  labels?: AssigneeDisplayLabels;
  authorityRole?: "responsibility" | "reviewer";
}): AssigneePickerViewModel {
  const labels = input.labels ?? DEFAULT_ASSIGNEE_DISPLAY_LABELS;
  const mode = resolveAssigneePickerMode({
    status: input.status,
    syncPhase: input.syncPhase,
    staleConflict: input.staleConflict,
    loading: input.loading
  });

  const connectedMember = canAssignWork({ status: input.status, members: input.members });
  let editBlockedReason: AssigneeUnavailableReason | null = null;
  if (mode === "disconnected" || mode === "connecting") editBlockedReason = "not_connected";
  else if (mode === "offline") editBlockedReason = "offline";
  else if (mode === "forbidden") editBlockedReason = "forbidden";
  else if (mode === "auth_expired") editBlockedReason = "auth_expired";
  else if (mode === "error") editBlockedReason = "server_error";
  else if (mode === "stale_conflict") editBlockedReason = "stale_conflict";
  else if (!connectedMember) editBlockedReason = "role_insufficient";
  else if (input.pending) editBlockedReason = "submitting";

  const canEdit = editBlockedReason === null;

  const sections = buildAssigneeSections({
    workItem: input.workItem,
    assignment: input.assignment,
    members: input.members,
    eligible: input.eligible,
    labels,
    authorityRole: input.authorityRole
  }).map((section) => ({
    ...section,
    options: section.options.map((option) => ({
      ...option,
      selectable: canEdit && option.selectable,
      unavailableReason:
        !canEdit && option.selectable ? editBlockedReason : option.unavailableReason
    }))
  }));

  const filteredSections = filterAssigneeSections(sections, input.query ?? "");
  const filteredOptions = filteredSections.flatMap((section) => section.options);

  const lastError =
    typeof input.lastError === "string"
      ? input.lastError
      : input.lastError
        ? input.lastError.message || input.lastError.code
        : null;

  return {
    mode,
    workItemKey: workItemKey(input.workItem),
    workItem: input.workItem,
    canEdit,
    editBlockedReason,
    current: buildAssigneeCurrentDisplay(input.assignment, labels),
    sections: filteredSections,
    filteredOptions,
    pending: input.pending,
    lastError,
    expectedRevision: input.assignment?.revision ?? 0,
    staleConflict: mode === "stale_conflict"
  };
}
