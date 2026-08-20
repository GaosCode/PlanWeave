export {
  WORK_ASSIGNMENT_BATCH_MAX,
  WORK_ELIGIBLE_HOST_BATCH_MAX,
  WORK_ASSIGNMENT_INITIAL_REVISION,
  WORK_ASSIGN_REASON_MAX_LENGTH,
  WORK_HOST_DISPLAY_NAME_MAX_LENGTH,
  WORK_HOST_DISPLAY_NAME_MIN_LENGTH
} from "./limits.js";

export {
  WORK_ASSIGNMENT_ERROR_MESSAGES,
  allowWorkAssignment,
  denyWorkAssignment,
  workAssignmentErrorCodeSchema,
  type WorkAssignmentAllowance,
  type WorkAssignmentAuthDecision,
  type WorkAssignmentDenial,
  type WorkAssignmentErrorCode
} from "./errors.js";

export {
  assertTargetAllowedForWorkItem,
  assignmentAvailabilityReasonSchema,
  assignmentAvailabilitySchema,
  assignmentConcurrencyFactsSchema,
  assignmentDisplayProjectionSchema,
  assignmentHostDisplaySchema,
  assignmentHostFactsSchema,
  assignmentHumanDisplaySchema,
  assignmentMembershipFactsSchema,
  assignmentRecordSchema,
  assignmentTargetSchema,
  assignmentUpdateCommandSchema,
  isMachineAssignmentTarget,
  workAssignmentBatchLimitSchema,
  workItemPackageFactsSchema,
  workItemRefSchema,
  type AssignmentAvailability,
  type AssignmentAvailabilityReason,
  type AssignmentConcurrencyFacts,
  type AssignmentDisplayProjection,
  type AssignmentHostDisplay,
  type AssignmentHostFacts,
  type AssignmentHumanDisplay,
  type AssignmentMembershipFacts,
  type AssignmentRecord,
  type AssignmentTarget,
  type AssignmentUpdateCommand,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";

export {
  blockWorkItemRef,
  createCompiledGraphWorkItemPort,
  createManifestWorkItemPort,
  splitBlockRef,
  taskWorkItemRef,
  validateWorkItemRef,
  workItemFactsFromCompiledGraph,
  workItemFactsFromManifest,
  type WorkItemPackagePort
} from "./workItemFacts.js";

export {
  assignmentChangeAffectsActiveDispatch,
  authorizeAssignmentMutation,
  decideAssignmentUpdate,
  evaluateAssignmentAvailability,
  evaluateAssignmentRevision,
  evaluateAssignmentTarget,
  evaluateDispatchAgainstAssignment,
  hostSatisfiesCapabilities,
  humanSubjectForAssignment,
  projectAssignmentDisplay,
  type AssignmentUpdateDecision,
  type CoordinationOperationKind,
  type DispatchAssignmentGateDecision
} from "./policy.js";

export {
  createHostAssignmentPort,
  createIdentityMembershipPort,
  createRoutedWorkItemPackagePort,
  type AssignmentHostPort,
  type AssignmentHostPortFromRepositoryOptions,
  type AssignmentMembershipPort,
  type AssignmentMembershipPortFromIdentityOptions
} from "./ports.js";

export {
  WorkAssignmentError,
  WorkAssignmentRepository,
  workItemKeyParts,
  type WorkAssignmentRepositoryOptions,
  type WorkItemKeyParts
} from "./repository.js";

export {
  WorkAssignmentService,
  WorkAssignmentServiceError,
  type AssignmentListResult,
  type EligibleAssigneesResult,
  type WorkAssignmentServiceOptions
} from "./service.js";

export {
  DispatchAssignmentError,
  createActiveDispatchResolver,
  createAssignmentDispatchGate,
  dispatchHostSelectionSnapshotSchema,
  resolveActiveDispatchSnapshot,
  resolveDispatchAssignment,
  type ActiveDispatchSnapshot,
  type AssignmentDispatchGate,
  type CreateAssignmentDispatchGateOptions,
  type DispatchHostSelectionSnapshot,
  type ResolveDispatchAssignmentInput,
  type ResolveDispatchAssignmentResult
} from "./dispatchIntegration.js";

export {
  handleWorkAssignmentHttpRequest,
  resetWorkAssignmentHttpRateLimits,
  type WorkAssignmentHttpOptions
} from "./http.js";

export {
  AuthorityRepository,
  type AuthorityRepositoryOptions
} from "./authorityRepository.js";
export {
  AuthorityService,
  type AuthorityServiceOptions
} from "./authorityService.js";
export {
  authorityScopeSchema,
  authorityRevisionSnapshotSchema,
  authorityActorSchema,
  responsibilityMutationSchema,
  reviewerMutationSchema,
  executionTargetMutationSchema,
  exactBlockScopeSchema,
  type AuthorityScope,
  type AuthorityActor,
  type AuthorityRevisionSnapshot,
  type ResponsibilityMutation,
  type ReviewerMutation,
  type ExecutionTargetMutation
} from "./authoritySchemas.js";
export {
  assertHumanScopeAuthorized,
  assertAssignmentPrincipalActive,
  assertExecutionTargetMutation,
  hostCanSatisfyBlock,
  evaluateHostAuthorization,
  type AuthorityPolicyErrorCode
} from "./authorityPolicy.js";
export {
  WorkRuntimeUnavailableError,
  withWorkRuntimeFacts,
  type WorkRuntimePackageFactsPort,
  type WorkRuntimeFactsLease,
  type WorkRuntimeFactsRequest
} from "./runtimePort.js";
