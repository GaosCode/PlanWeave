export type {
  DesktopProjectProjection,
  DesktopProjectProjectionContext
} from "./projectProjectionCache.js";
export {
  invalidateDesktopProjectProjection,
  invalidateDesktopCanvasProjection,
  invalidateDesktopProjectProjectionDerived,
  peekDesktopCanvasProjectionCacheEntryForTests
} from "./projectProjectionCache.js";
export {
  readDesktopProjectProjectionContext,
  readDesktopProjectProjection,
  readDesktopProjectSearchIndex,
  readDesktopProjectSearchIndexFromContext,
  buildDesktopProjectStatisticsProjectionFromProjection,
  readDesktopProjectStatisticsProjection
} from "./projectProjectionReaders.js";
