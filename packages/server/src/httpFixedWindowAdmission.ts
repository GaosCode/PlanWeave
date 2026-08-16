export type FixedWindowAdmissionResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type BoundedFixedWindowAdmissionOptions = {
  windowMs: number;
  maxRequests: number;
  maxBuckets: number;
};

type FixedWindowBucket = {
  windowStartedAt: number;
  count: number;
};

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name}_must_be_a_positive_safe_integer`);
  }
}

function requireTimestamp(now: number, windowMs: number): void {
  if (!Number.isSafeInteger(now)) {
    throw new RangeError("fixed_window_now_must_be_a_safe_integer");
  }
  if (!Number.isSafeInteger(now + windowMs)) {
    throw new RangeError("fixed_window_expiry_must_be_a_safe_integer");
  }
}

function retryAfterSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1_000));
}

/**
 * In-process fixed-window admission with a strict cardinality bound.
 * Active buckets are never evicted because doing so would reset an existing key's quota.
 */
export class BoundedFixedWindowAdmission<Key> {
  readonly #windowMs: number;
  readonly #maxRequests: number;
  readonly #maxBuckets: number;
  readonly #buckets = new Map<Key, FixedWindowBucket>();

  constructor(options: BoundedFixedWindowAdmissionOptions) {
    requirePositiveInteger(options.windowMs, "fixed_window_window_ms");
    requirePositiveInteger(options.maxRequests, "fixed_window_max_requests");
    requirePositiveInteger(options.maxBuckets, "fixed_window_max_buckets");
    this.#windowMs = options.windowMs;
    this.#maxRequests = options.maxRequests;
    this.#maxBuckets = options.maxBuckets;
  }

  admit(key: Key, now: number): FixedWindowAdmissionResult {
    requireTimestamp(now, this.#windowMs);
    const current = this.#buckets.get(key);
    if (current && now < current.windowStartedAt + this.#windowMs) {
      if (current.count >= this.#maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(current.windowStartedAt + this.#windowMs, now)
        };
      }
      current.count += 1;
      return { allowed: true };
    }

    let earliestActiveExpiry = Number.POSITIVE_INFINITY;
    for (const [candidateKey, bucket] of this.#buckets) {
      const expiresAt = bucket.windowStartedAt + this.#windowMs;
      if (now >= expiresAt) {
        this.#buckets.delete(candidateKey);
      } else if (expiresAt < earliestActiveExpiry) {
        earliestActiveExpiry = expiresAt;
      }
    }

    if (this.#buckets.size >= this.#maxBuckets) {
      if (!Number.isSafeInteger(earliestActiveExpiry)) {
        throw new Error("fixed_window_active_expiry_unavailable");
      }
      return {
        allowed: false,
        retryAfterSeconds: retryAfterSeconds(earliestActiveExpiry, now)
      };
    }

    this.#buckets.set(key, { windowStartedAt: now, count: 1 });
    return { allowed: true };
  }

  reset(): void {
    this.#buckets.clear();
  }

  bucketCount(): number {
    return this.#buckets.size;
  }
}
