/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {IHeapNode} from '@memlab/core';
import {getCurrentHandle} from './heap-state.js';
import type {Page} from './pagination.js';
import {clampLabelTo, toolResult} from './utils.js';

/**
 * Machine-readable results next to the human-readable text.
 *
 * The text is for reading; chaining one tool into the next used to mean
 * re-parsing its markdown tables. `structuredContent` carries the same facts
 * as JSON: node ids scoped to their snapshot, raw byte counts, the filters and
 * sort order that applied, and paging.
 */

export interface NodeRef {
  id: number;
  name: string;
  type: string;
  self_size: number;
  retained_size: number;
}

export function nodeRef(node: IHeapNode): NodeRef {
  return {
    id: node.id,
    name: clampLabelTo(node.name, 200),
    type: node.type,
    self_size: node.self_size,
    retained_size: node.retainedSize,
  };
}

export interface PageInfo {
  offset: number;
  page_size: number;
  total: number;
  next_offset: number | null;
}

export function pageInfo(page: Page<unknown>): PageInfo {
  return {
    offset: page.offset,
    page_size: page.pageSize,
    total: page.total,
    next_offset: page.nextOffset,
  };
}

/**
 * `toolResult` plus `structuredContent`. `snapshot` defaults to the active
 * handle, so every id in `data` is scoped to the capture it came from.
 */
export function structuredResult(
  text: string,
  data: Record<string, unknown>,
  options: {snapshot?: string | null; header?: string | null} = {},
) {
  const result = toolResult(text, options.header);
  const snapshot =
    options.snapshot !== undefined ? options.snapshot : getCurrentHandle();
  return {
    ...result,
    structuredContent: {...(snapshot != null ? {snapshot} : {}), ...data},
  };
}
