import { describe, expect, it } from "vitest";
import { BoundedFixedWindowAdmission } from "../httpFixedWindowAdmission.js";

describe("bounded fixed-window HTTP admission", () => {
  it("returns exact retry-after values and resets the quota at window expiry", () => {
    const admission = new BoundedFixedWindowAdmission<string>({
      windowMs: 60_000,
      maxRequests: 2,
      maxBuckets: 10
    });

    expect(admission.admit("subject", 1_000)).toEqual({ allowed: true });
    expect(admission.admit("subject", 1_000)).toEqual({ allowed: true });
    expect(admission.admit("subject", 1_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 60
    });
    expect(admission.admit("subject", 31_001)).toEqual({
      allowed: false,
      retryAfterSeconds: 30
    });
    expect(admission.admit("subject", 60_999)).toEqual({
      allowed: false,
      retryAfterSeconds: 1
    });
    expect(admission.admit("subject", 61_000)).toEqual({ allowed: true });
  });

  it("allows exactly maxRequests before rejecting the next request", () => {
    const admission = new BoundedFixedWindowAdmission<string>({
      windowMs: 10_000,
      maxRequests: 3,
      maxBuckets: 1
    });

    expect(Array.from({ length: 3 }, () => admission.admit("subject", 0))).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true }
    ]);
    expect(admission.admit("subject", 0)).toEqual({
      allowed: false,
      retryAfterSeconds: 10
    });
  });

  it("fails closed at capacity without growing or evicting active buckets", () => {
    const admission = new BoundedFixedWindowAdmission<string>({
      windowMs: 10_000,
      maxRequests: 2,
      maxBuckets: 2
    });

    expect(admission.admit("earliest", 0)).toEqual({ allowed: true });
    expect(admission.admit("later", 1_000)).toEqual({ allowed: true });
    expect(admission.admit("new", 2_500)).toEqual({
      allowed: false,
      retryAfterSeconds: 8
    });
    expect(admission.bucketCount()).toBe(2);
    expect(admission.admit("earliest", 2_500)).toEqual({ allowed: true });
    expect(admission.admit("earliest", 2_500)).toEqual({
      allowed: false,
      retryAfterSeconds: 8
    });
    expect(admission.admit("new", 10_000)).toEqual({ allowed: true });
    expect(admission.bucketCount()).toBe(2);
  });

  it("clears state and rejects invalid configuration or clock input", () => {
    expect(
      () => new BoundedFixedWindowAdmission({ windowMs: 0, maxRequests: 1, maxBuckets: 1 })
    ).toThrow("fixed_window_window_ms_must_be_a_positive_safe_integer");
    expect(
      () => new BoundedFixedWindowAdmission({ windowMs: 1, maxRequests: 1.5, maxBuckets: 1 })
    ).toThrow("fixed_window_max_requests_must_be_a_positive_safe_integer");
    expect(
      () => new BoundedFixedWindowAdmission({ windowMs: 1, maxRequests: 1, maxBuckets: Infinity })
    ).toThrow("fixed_window_max_buckets_must_be_a_positive_safe_integer");

    const admission = new BoundedFixedWindowAdmission<string>({
      windowMs: 1_000,
      maxRequests: 1,
      maxBuckets: 1
    });
    expect(() => admission.admit("subject", Number.NaN)).toThrow(
      "fixed_window_now_must_be_a_safe_integer"
    );
    expect(() => admission.admit("subject", Number.MAX_SAFE_INTEGER)).toThrow(
      "fixed_window_expiry_must_be_a_safe_integer"
    );
    expect(admission.admit("subject", 0)).toEqual({ allowed: true });
    admission.reset();
    expect(admission.bucketCount()).toBe(0);
    expect(admission.admit("subject", 0)).toEqual({ allowed: true });
  });
});
