// A4 public surface — durable events and WebSocket sync.
//
// Anything not exported here is a module-internal helper.

export { applyEventsMigrations, eventsMigrations } from "./migrations.js";
export {
  createEventPublisher,
  type EventPublisher,
  type EventPublisherOptions,
  subscriberQueueCapacity,
  dequeueEvent,
} from "./publisher.js";
export {
  createEventWebSocketServer,
  type EventWebSocketServer,
  type EventWebSocketServerOptions,
  WS_PATH,
} from "./wsServer.js";
export {
  createEventHttpApi,
  type EventHttpApi,
  type EventHttpApiOptions,
} from "./httpApi.js";
export {
  readEventsPage,
  readProjectSnapshot,
  readLastEventId,
  readOldestEventIdWithinRetention,
  RepositoryError,
  DEFAULT_PUBLISHER_BATCH_SIZE,
} from "./repository.js";
export {
  createSubscriber,
  enqueueEvent,
  dequeueEvent as dequeueEventFromSubscriber,
  isClosed,
  markClosed,
  toSubscriberRow,
  type Subscriber,
  type SubscriberOutboundMessage,
  type SubscriberCloseReason,
  type SubscriberRow,
} from "./subscriber.js";
export {
  buildApiError,
  writeApiError,
  API_ERROR_STATUS,
} from "./errors.js";
export * from "./types.js";
