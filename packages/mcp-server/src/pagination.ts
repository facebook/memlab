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
import {formatNumber} from './utils.js';

/**
 * One paging contract for every ranked list: skip `offset` rows, show the
 * next page, end with the same footer, and hand the next offset back. Lists
 * must be sorted deterministically (ties broken by id) before paging, or the
 * same offset shows different rows on two calls.
 */

export interface Page<T> {
  items: T[];
  /** The offset actually used (see `notice`). */
  offset: number;
  pageSize: number;
  total: number;
  /** Offset of the next page, or null on the last one. */
  nextOffset: number | null;
  /** Set when the requested offset was out of range. */
  notice?: string;
}

export function paginate<T>(
  all: ArrayLike<T>,
  offset: number | undefined,
  pageSize: number,
): Page<T> {
  const total = all.length;
  const size = Math.max(1, Math.floor(pageSize));
  let start = Math.max(0, Math.floor(offset ?? 0));
  let notice: string | undefined;
  if (start >= total && total > 0) {
    notice = `\`offset\` ${formatNumber(start)} is past the last of ${formatNumber(total)}; showing the first page.`;
    start = 0;
  }
  const end = Math.min(total, start + size);
  return {
    // Copy only the page: `all` may be a large typed array.
    items: Array.prototype.slice.call(all, start, end) as T[],
    offset: start,
    pageSize: size,
    total,
    nextOffset: end < total ? end : null,
    notice,
  };
}

/** "Showing 21–40 of 1,234 (page 2 of 62). Next page: `offset: 40`." */
export function pageFooter(page: Page<unknown>, unit = ''): string {
  if (page.total === 0) return '';
  const pages = Math.ceil(page.total / page.pageSize);
  const current = Math.floor(page.offset / page.pageSize) + 1;
  // A page number means something only on the page grid: an offset between
  // grid lines would share its number with the page before it.
  const onGrid = page.offset % page.pageSize === 0;
  const what = unit ? ` ${unit}` : '';
  return (
    `Showing ${formatNumber(page.offset + 1)}–${formatNumber(page.offset + page.items.length)} of ${formatNumber(page.total)}${what}` +
    (pages > 1 && onGrid
      ? ` (page ${current} of ${formatNumber(pages)})`
      : '') +
    '.' +
    (page.nextOffset != null
      ? ` Next page: \`offset: ${page.nextOffset}\`.`
      : '')
  );
}

/** The notice (if any) and the footer, ready to append to a report. */
export function pageLines(page: Page<unknown>, unit = ''): string[] {
  const footer = pageFooter(page, unit);
  return [
    ...(page.notice != null ? [page.notice] : []),
    ...(footer ? [footer] : []),
  ];
}

/** The footer for a top-N list whose total is not computed. */
export function openPageFooter(
  offset: number,
  shown: number,
  hasMore: boolean,
): string {
  if (shown === 0) return '';
  return (
    `Showing ${formatNumber(offset + 1)}–${formatNumber(offset + shown)}.` +
    (hasMore ? ` Next page: \`offset: ${offset + shown}\`.` : '')
  );
}

export function offsetParam() {
  return z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe(
      'Rows to skip before this page (default 0). Each result ends with the offset of the next page.',
    );
}
