import type {
  listExecutorProfiles,
  testExecutorProfile,
  ExecutorPreflightResult,
  ExecutorProfileAdapter,
  ExecutorProfileSummary,
  ExecutorIntegrationName
} from "../index.js";

const legacyPreflightResult: ExecutorPreflightResult = {
  name: "manual",
  adapter: "manual",
  ok: true,
  message: "manual executor does not require a command",
  checks: []
};

const legacyProfileSummary: ExecutorProfileSummary = {
  name: "manual",
  adapter: "manual",
  source: "builtin"
};

type ProducedPreflightResult = Awaited<ReturnType<typeof testExecutorProfile>>;
type ProducedProfileSummary = Awaited<ReturnType<typeof listExecutorProfiles>>[number];

declare const producedPreflightResult: ProducedPreflightResult;
declare const producedProfileSummary: ProducedProfileSummary;

const producedPreflightAdapter: ExecutorProfileAdapter | null =
  producedPreflightResult.profileAdapter;
const producedPreflightIntegration: ExecutorIntegrationName | null =
  producedPreflightResult.executionIntegration;
const producedPreflightAgentName: string | null =
  producedPreflightResult.agentInfo?.name ?? null;
const producedSummaryAdapter: ExecutorProfileAdapter = producedProfileSummary.profileAdapter;
const producedSummaryIntegration: ExecutorIntegrationName | null =
  producedProfileSummary.executionIntegration;
