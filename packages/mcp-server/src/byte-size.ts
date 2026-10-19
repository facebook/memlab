/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {z} from 'zod';

// Decimal units are powers of 1000 and binary units powers of 1024, as their
// names say. A bare letter is decimal.
const UNIT_BYTES: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1e3,
  kb: 1e3,
  kib: 1024,
  m: 1e6,
  mb: 1e6,
  mib: 1024 ** 2,
  g: 1e9,
  gb: 1e9,
  gib: 1024 ** 3,
};

const SIZE_RE = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i;

/** "1500", "1.5KB", "2MiB" → bytes. Throws on anything else. */
export function parseByteSize(text: string): number {
  const m = SIZE_RE.exec(text.trim());
  const unit = m ? UNIT_BYTES[m[2].toLowerCase()] : undefined;
  if (m == null || unit == null) {
    throw new Error(
      `"${text}" is not a size. Use a number of bytes or a unit: 500KB, 1.5MB, 2MiB (KB = 1000 bytes, KiB = 1024).`,
    );
  }
  return Math.round(Number(m[1]) * unit);
}

export interface ByteRange {
  min: number;
  max: number;
}

/**
 * An inclusive size range. A number or a single size is a minimum; "a-b" is a
 * range, "-b" an upper bound only and "a-" a lower bound only.
 */
export function parseByteRange(value: number | string): ByteRange {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${value} is not a size: use 0 or more bytes.`);
    }
    return {min: value, max: Infinity};
  }
  const text = value.trim();
  const dash = text.indexOf('-');
  if (dash < 0) {
    return {min: parseByteSize(text), max: Infinity};
  }
  const lo = text.slice(0, dash).trim();
  const hi = text.slice(dash + 1).trim();
  if ((lo === '' && hi === '') || hi.includes('-')) {
    throw new Error(
      `"${value}" is not a size range. Use "1MB" (at least), "1MB-10MB", "-1MB" (at most) or "1MB-".`,
    );
  }
  const range = {
    min: lo === '' ? 0 : parseByteSize(lo),
    max: hi === '' ? Infinity : parseByteSize(hi),
  };
  if (range.min > range.max) {
    throw new Error(`"${value}": the lower bound is above the upper bound.`);
  }
  return range;
}

export function inByteRange(bytes: number, range: ByteRange | null): boolean {
  return range == null || (bytes >= range.min && bytes <= range.max);
}

/** Schema for a size-range parameter: bytes, or a string like "1MB-". */
export function byteRangeParam(what: string) {
  return z
    .union([z.number(), z.string()])
    .optional()
    .describe(
      `${what}: bytes (a minimum), or "1MB" (at least), "1MB-10MB", "-1MB" (at most), "500KB-". KB = 1000 bytes, KiB = 1024.`,
    );
}

/**
 * A byte-size parameter that accepts a number of bytes or a size string
 * ("1MB", "500KiB"), and hands the tool a number either way. Strings are
 * converted during validation, so tool code is unchanged.
 */
export function sizeInput(base: z.ZodNumber = z.number()) {
  return z.union([base, z.string()]).transform((value, ctx) => {
    if (typeof value === 'number') return value;
    try {
      const bytes = parseByteSize(value);
      // The base's own constraints (`.int()`, `.min()`) apply to a parsed
      // string too, or "500B" would get past a floor that rejects 500.
      const checked = base.safeParse(bytes);
      if (!checked.success) {
        for (const issue of checked.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return checked.data;
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
      return z.NEVER;
    }
  });
}

/** Append the accepted forms to a size parameter's description. */
export function withSizeHint(description: string): string {
  return `${description} Bytes, or a size such as "1MB" or "500KiB" (KB = 1000 bytes, KiB = 1024).`;
}
