import { z } from "zod";

export const packageStorageIdentitySchema = z.union([
  z.string().regex(/^directory:\d+:\d+:\d+$/),
  z.string().regex(/^instance:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/)
]);

export const resultsStorageIdentitySchema = z.union([z.literal("initial"), z.string().uuid()]);
