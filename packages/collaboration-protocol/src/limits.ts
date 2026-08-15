/**
 * Public wire budgets for human collaboration DTOs.
 * Aligned with Server HC domain limits; contracts package is the Desktop wire authority.
 */

export const HUMAN_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const HUMAN_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const HUMAN_DEVICE_LABEL_MAX_LENGTH = 64 as const;

export const HUMAN_COMMENT_BODY_MAX_LENGTH = 16_384 as const;
export const HUMAN_COMMENT_BODY_MIN_LENGTH = 1 as const;
export const HUMAN_ASSIGN_REASON_MAX_LENGTH = 512 as const;

export const HUMAN_DEVICE_TOKEN_PREFIX = "pw_hdev_" as const;
export const PROJECT_INVITATION_TOKEN_PREFIX = "pw_inv_" as const;
export const HUMAN_TOKEN_SECRET_CHAR_LENGTH = 43 as const;

export const PROJECT_INVITATION_MIN_TTL_MS = 60_000 as const;
export const PROJECT_INVITATION_MAX_TTL_MS = 604_800_000 as const;
export const PROJECT_INVITATION_DEFAULT_TTL_MS = 86_400_000 as const;
/** Client-generated invitation-create retry identity. */
export const HUMAN_INVITATION_IDEMPOTENCY_KEY_MAX_LENGTH = 128 as const;

export const HUMAN_DEVICE_MIN_TTL_MS = 60_000 as const;
export const HUMAN_DEVICE_MAX_TTL_MS = 31_536_000_000 as const;

export const HUMAN_MAX_DEVICES_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_MEMBERS_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE = 100 as const;

export const WORK_HOST_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const WORK_HOST_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const WORK_ASSIGNMENT_BATCH_MAX = 100 as const;
/** Assignment refresh page budget for one bounded eligible-Host projection. */
export const WORK_ELIGIBLE_HOST_BATCH_MAX = 50 as const;

/** Bounded revisions and public collaboration assignment reason text. */
export const COLLABORATION_REVISION_MAX = 9_007_199_254_740_991 as const;
export const COLLABORATION_REASON_MAX_LENGTH = 512 as const;
export const HOST_AUTHORIZATION_CAPABILITIES_MAX = 128 as const;

export const COMMENT_BODY_FORMAT = "markdown" as const;
export const COMMENT_ATTACHMENTS_MAX_COUNT = 8 as const;
export const COMMENT_ATTACHMENT_MAX_BYTES = 8_388_608 as const;
export const COMMENT_ATTACHMENT_FILENAME_MIN_LENGTH = 1 as const;
export const COMMENT_ATTACHMENT_FILENAME_MAX_LENGTH = 255 as const;
export const COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown"
] as const;

export const COMMENT_LIST_PAGE_MIN = 1 as const;
export const COMMENT_LIST_PAGE_MAX = 50 as const;
export const COMMENT_LIST_PAGE_DEFAULT = 20 as const;
export const ACTIVITY_LIST_PAGE_MIN = 1 as const;
export const ACTIVITY_LIST_PAGE_MAX = 50 as const;
export const ACTIVITY_LIST_PAGE_DEFAULT = 20 as const;
export const ACTIVITY_HEADLINE_MAX_LENGTH = 256 as const;
export const ACTIVITY_SUBJECTS_MAX_COUNT = 8 as const;
export const COMMENT_TOMBSTONE_REASON_MAX_LENGTH = 512 as const;

/** Default JSON response body budget for human collaboration HTTP clients. */
export const COLLABORATION_JSON_RESPONSE_MAX_BYTES = 4 * 1_024 * 1_024;

/**
 * Backward-compatible public name for the collaboration JSON response budget.
 * Server request admission limits are enforced independently at their HTTP boundaries.
 */
export const COLLABORATION_JSON_BODY_MAX_BYTES = COLLABORATION_JSON_RESPONSE_MAX_BYTES;

/** Default max WebSocket frame size for the human observer channel. */
export const HUMAN_OBSERVER_MAX_PAYLOAD_BYTES = 262_144 as const;

/** Human observer protocol version (distinct from Agent Host protocol). */
export const HUMAN_OBSERVER_PROTOCOL_VERSION = 1 as const;

/** Ephemeral canvas presence protocol and admission budgets. */
export const CANVAS_PRESENCE_PROTOCOL_VERSION = 1 as const;
export const CANVAS_PRESENCE_MAX_FRAME_BYTES = 262_144 as const;
export const CANVAS_PRESENCE_COORDINATE_ABS_MAX = 1_000_000 as const;
export const CANVAS_PRESENCE_SELECTION_ID_MAX_LENGTH = 128 as const;
export const CANVAS_PRESENCE_MAX_SELECTION_IDS = 32 as const;
export const CANVAS_PRESENCE_MAX_SESSIONS_PER_CANVAS = 32 as const;
export const CANVAS_PRESENCE_MAX_UPDATES_PER_SECOND = 30 as const;
export const CANVAS_PRESENCE_SESSION_TTL_MS = 15_000 as const;

/**
 * Durable server-authoritative Canvas command / journal / snapshot budgets.
 * Presence limits above are independent and must not be reused as mutation cursors.
 */
export const CANVAS_COMMAND_PROTOCOL_VERSION = 1 as const;
/** Max UTF-16 code units for one command/journal/reconnect wire frame. */
export const CANVAS_COMMAND_MAX_FRAME_BYTES = 1_048_576 as const;
export const CANVAS_COMMAND_MAX_PROMPT_MARKDOWN_CHARS = 262_144 as const;
export const CANVAS_COMMAND_MAX_TITLE_LENGTH = 256 as const;
export const CANVAS_COMMAND_MAX_ACCEPTANCE_ITEMS = 64 as const;
export const CANVAS_COMMAND_MAX_ACCEPTANCE_ITEM_LENGTH = 512 as const;
export const CANVAS_COMMAND_MAX_DEPENDS_ON = 128 as const;
export const CANVAS_COMMAND_MAX_BULK_UPDATES = 64 as const;
export const CANVAS_COMMAND_MAX_LAYOUT_NODES = 512 as const;
export const CANVAS_COMMAND_MAX_BLOCK_PROMPT_ENTRIES = 64 as const;
export const CANVAS_COMMAND_MAX_SHARED_RESOURCES = 32 as const;
export const CANVAS_COMMAND_MAX_SHARED_RESOURCE_LENGTH = 128 as const;
export const CANVAS_COMMAND_MAX_CAPABILITIES = 32 as const;
export const CANVAS_COMMAND_MAX_CAPABILITY_LENGTH = 128 as const;
export const CANVAS_COMMAND_MAX_REASON_LENGTH = 512 as const;
/** Max journal entries returned in one reconnect delta response. */
export const CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES = 256 as const;
/** Contract-level retention bound for Server journal policy documentation/tests. */
export const CANVAS_COMMAND_MAX_JOURNAL_RETAINED = 10_000 as const;
/** Exact terminal-operation idempotency receipts retained per Canvas scope. */
export const CANVAS_COMMAND_TERMINAL_RECEIPT_WINDOW = 10_000 as const;
/** Coordinate bounds for layout nodes on the shared canvas (same scale as presence). */
export const CANVAS_COMMAND_LAYOUT_COORDINATE_ABS_MAX = CANVAS_PRESENCE_COORDINATE_ABS_MAX;

/** Server-to-Desktop accepted Canvas journal stream (read-only WebSocket). */
export const CANVAS_LIVE_SYNC_PROTOCOL_VERSION = 1 as const;
export const CANVAS_LIVE_SYNC_MAX_FRAME_BYTES = CANVAS_COMMAND_MAX_FRAME_BYTES;

/** Default HTTPS request timeout. */
export const COLLABORATION_REQUEST_TIMEOUT_MS = 30_000 as const;

/** Bounded project/canvas ACL and Plan Package registry metadata budgets. */
export const PROJECT_ACCESS_MAX_GRANTS = 1_000 as const;
export const PROJECT_ACCESS_MAX_PROJECTS_PER_PAGE = 100 as const;
export const PROJECT_ACCESS_MAX_CANVASES_PER_PAGE = 100 as const;
export const PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS = 4_096 as const;
export const PACKAGE_SNAPSHOT_MAX_PATH_LENGTH = 512 as const;
export const PACKAGE_SNAPSHOT_MAX_SOURCE_REVISION_LENGTH = 256 as const;
export const PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES = 256 * 1_024 * 1_024;
export const PACKAGE_SNAPSHOT_MAX_FILE_BYTES = 64 * 1_024 * 1_024;
export const PACKAGE_SNAPSHOT_MAX_RETAINED = 256 as const;

/** Immutable authoritative content-version transfer and registry budgets. */
export const CONTENT_VERSION_MAX_MEMBERS = PACKAGE_SNAPSHOT_MAX_PROMPT_DIGESTS + 2;
export const CONTENT_VERSION_MAX_MEMBER_BYTES = PACKAGE_SNAPSHOT_MAX_FILE_BYTES;
export const CONTENT_VERSION_MAX_TOTAL_BYTES = PACKAGE_SNAPSHOT_MAX_TOTAL_BYTES;
export const CONTENT_VERSION_MAX_REASON_LENGTH = 512 as const;
/** NDJSON transfer frames include JSON escaping, so their wire ceiling is larger than member bytes. */
export const CONTENT_VERSION_TRANSFER_MAX_FRAME_BYTES =
  CONTENT_VERSION_MAX_MEMBER_BYTES * 6 + 65_536;
/** The aggregate escaped wire budget, including header and completion frames. */
export const CONTENT_VERSION_TRANSFER_MAX_WIRE_BYTES =
  CONTENT_VERSION_MAX_TOTAL_BYTES * 6 + (CONTENT_VERSION_MAX_MEMBERS + 2) * 65_536;

/**
 * One-time Workspace setup code budgets.
 * Distinct from host enrollment (`pw_enroll_`), human device (`pw_hdev_`), and invitation tokens.
 */
export const SETUP_CODE_TOKEN_PREFIX = "pw_setup_" as const;
export const SETUP_CODE_MIN_TTL_MS = 60_000 as const;
export const SETUP_CODE_MAX_TTL_MS = 86_400_000 as const;
export const SETUP_CODE_DEFAULT_TTL_MS = 3_600_000 as const;
export const SETUP_CODE_MAX_LISTED_PER_PAGE = 100 as const;
export const SETUP_CODE_REASON_MAX_LENGTH = 512 as const;
export const WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE = 100 as const;
export const HOST_BOOTSTRAP_HANDOFF_REASON_MAX_LENGTH = 512 as const;
