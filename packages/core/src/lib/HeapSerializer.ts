/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @lightSyntaxTransform
 * @oncall memory_lab
 */

'use strict';

import type {IHeapSnapshot, RawHeapSnapshot} from './Types';

import fs from 'fs';

/**
 * Write a parsed heap snapshot back to a `.heapsnapshot` file.
 *
 * The inverse of `HeapParser`, and deliberately written the same way it is:
 * one reusable fixed-size buffer, filled and flushed, never a whole-file or
 * whole-section string.
 *
 * **Why that matters more than ordinary memory hygiene.** V8's string limit is
 * hard, not soft: `buffer.constants.MAX_STRING_LENGTH` is 512 MB, so
 * `JSON.stringify(rawSnapshot)` on a 1 GB capture does not merely spike RSS, it
 * throws `RangeError: Invalid string length` and there is no larger machine
 * that fixes it. `JSON.stringify(nodes)` alone is ~156 MB on a 7.1M-node
 * capture and scales linearly, so the per-array shortcut runs out too. Every
 * value here is therefore appended one element at a time.
 */

/** Chrome writes the top-level fields in this order; so do we. */
const FIELD_ORDER = [
  'nodes',
  'edges',
  'trace_function_infos',
  'trace_tree',
  'samples',
  'locations',
  'strings',
] as const;

const DEFAULT_BUFFER_SIZE = 4 * 1024 * 1024;

/**
 * A file writer that owns exactly one buffer for its lifetime.
 *
 * `fs.writeSync` rather than a write stream on purpose: a stream would need
 * backpressure handling on every one of ~42M appends, and the only thing that
 * buys is overlapping I/O with a loop that is already I/O-bound. The reader
 * side (`StringLoader`) is shaped the same way, so the two are symmetric.
 *
 * @internal
 */
export class ChunkedFileWriter {
  private fd: number;
  private buf: Buffer;
  private len = 0;

  constructor(file: string, bufferSize: number = DEFAULT_BUFFER_SIZE) {
    this.fd = fs.openSync(file, 'w');
    this.buf = Buffer.allocUnsafe(bufferSize);
  }

  /**
   * Append ASCII-only text. Callers use this for numbers and punctuation,
   * where byte length equals character length, so the capacity check needs no
   * `Buffer.byteLength` call — that check is otherwise the hot cost in a loop
   * that runs once per array element.
   */
  writeAscii(text: string): void {
    if (text.length > this.buf.length) {
      // `Buffer.write` truncates silently rather than throwing, so a token
      // longer than the buffer would corrupt the file with no error. Callers
      // only pass numbers and punctuation today; this keeps that assumption
      // from becoming a silent data bug if one ever passes something longer.
      this.write(text);
      return;
    }
    if (this.len + text.length > this.buf.length) {
      this.flush();
    }
    this.len += this.buf.write(text, this.len, 'latin1');
  }

  /** Append arbitrary text, measured in bytes rather than characters. */
  write(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (bytes > this.buf.length) {
      // Larger than the buffer will ever be: flush what is pending and hand
      // the payload straight to the OS rather than growing the buffer. One
      // 78 KB DOM string should not permanently raise the writer's footprint.
      this.flush();
      fs.writeSync(this.fd, text);
      return;
    }
    if (this.len + bytes > this.buf.length) {
      this.flush();
    }
    this.len += this.buf.write(text, this.len);
  }

  private flush(): void {
    if (this.len === 0) {
      return;
    }
    fs.writeSync(this.fd, this.buf, 0, this.len);
    this.len = 0;
  }

  close(): void {
    this.flush();
    fs.closeSync(this.fd);
  }
}

/** Numeric arrays reach us as typed arrays from the parser or plain arrays. */
type NumericArrayLike = ArrayLike<number>;

/**
 * Append `"field":[a,b,c]` without ever materializing the array as a string.
 *
 * @param writer the open writer to append to
 * @param field the JSON field name to emit
 * @param values the numeric values of the field, typed array or plain array
 *
 * @internal
 */
export function writeNumericArrayField(
  writer: ChunkedFileWriter,
  field: string,
  values: NumericArrayLike,
): void {
  writer.writeAscii(`"${field}":[`);
  for (let i = 0; i < values.length; ++i) {
    if (i > 0) {
      writer.writeAscii(',');
    }
    writer.writeAscii(String(values[i]));
  }
  writer.writeAscii(']');
}

/**
 * Append `"strings":[...]`, escaping one entry at a time.
 *
 * `JSON.stringify` is called per element rather than on the array so the
 * largest transient string is one heap string, not the whole table. Escaping
 * is delegated to it rather than hand-rolled because the table routinely holds
 * lone surrogates and control characters that a naive escaper corrupts into a
 * file Chrome DevTools will not open.
 *
 * @param writer the open writer to append to
 * @param field the JSON field name to emit
 * @param values the string table entries, in index order
 *
 * @internal
 */
export function writeStringArrayField(
  writer: ChunkedFileWriter,
  field: string,
  values: ArrayLike<string>,
): void {
  writer.writeAscii(`"${field}":[`);
  for (let i = 0; i < values.length; ++i) {
    if (i > 0) {
      writer.writeAscii(',');
    }
    writer.write(JSON.stringify(values[i]));
  }
  writer.writeAscii(']');
}

/**
 * Append `"trace_tree":[...]`, which is NOT a flat numeric array.
 *
 * `trace_node_fields` ends in `children`, so the tree nests: each node is
 * `[id, function_info_index, count, size, [ ...children ]]`. Emitting it with
 * the numeric writer stringifies each child array via `String(value)` and
 * writes `1,2,3` where `[1,2,3]` belongs — a file that no longer parses.
 *
 * It reads as flat on any capture taken without allocation tracking, because
 * then it is empty and every writer agrees. `RawHeapSnapshot` types the field
 * as `number`, which is how that goes unnoticed.
 */
function writeTraceTreeField(
  writer: ChunkedFileWriter,
  field: string,
  value: unknown,
): void {
  writer.writeAscii(`"${field}":[`);
  const writeElements = (items: readonly unknown[]): void => {
    for (let i = 0; i < items.length; ++i) {
      if (i > 0) {
        writer.writeAscii(',');
      }
      const item = items[i];
      if (Array.isArray(item)) {
        writer.writeAscii('[');
        writeElements(item);
        writer.writeAscii(']');
      } else {
        writer.writeAscii(String(item));
      }
    }
  };
  if (Array.isArray(value)) {
    writeElements(value);
  }
  writer.writeAscii(']');
}

/**
 * The `snapshot` header as the FILE should carry it, not as the parse left it.
 *
 * `HeapSnapshot._buildMetaData` appends a synthetic `'invisible'` entry to
 * `meta.edge_fields` **in place**, so a parsed snapshot's raw meta no longer
 * describes its own data. Writing that back produces a file whose reader
 * strides the edge array by 4 instead of 3 and misaligns every edge — it fails
 * as `Invalid toNodeIndex`, far from the cause, and only for snapshots that
 * went through the parser.
 *
 * Rather than special-casing that one known appendix, the field lists are
 * truncated to the width the data actually implies (`nodes.length /
 * node_count`). That is self-correcting for any future in-place annotation,
 * and it cannot silently shorten a legitimate field list: a real extra field
 * would come with real extra values per record.
 *
 * The header is copied rather than edited so serializing does not disturb the
 * live in-memory snapshot the caller is still using.
 */
function fileFaithfulHeader(raw: RawHeapSnapshot): unknown {
  const info = raw.snapshot as unknown as Record<string, unknown>;
  const meta = info.meta as Record<string, unknown> | undefined;
  if (meta == null) {
    return info;
  }
  const fitted: Record<string, unknown> = {...meta};
  const fit = (
    fieldsKey: string,
    values: ArrayLike<number> | undefined,
    recordCount: unknown,
  ): void => {
    const fields = meta[fieldsKey];
    if (!Array.isArray(fields) || typeof recordCount !== 'number') {
      return;
    }
    if (recordCount <= 0 || values == null) {
      return;
    }
    const width = values.length / recordCount;
    if (Number.isInteger(width) && width > 0 && width < fields.length) {
      fitted[fieldsKey] = fields.slice(0, width);
    }
  };
  fit('node_fields', raw.nodes, info.node_count);
  fit('edge_fields', raw.edges, info.edge_count);
  return {...info, meta: fitted};
}

/**
 * Serialize a `RawHeapSnapshot` to `outputFile`.
 *
 * The `snapshot` header is the one field stringified whole — it is a few
 * hundred bytes, and doing so preserves any key V8 added that
 * `HeapSnapshotInfo` does not model (`extra_native_bytes` is already one such).
 *
 * @param raw the raw snapshot data to write
 * @param outputFile absolute path of the `.heapsnapshot` file to create,
 * overwritten if it already exists
 *
 * @internal
 */
export function serializeRawHeapSnapshot(
  raw: RawHeapSnapshot,
  outputFile: string,
): void {
  const writer = new ChunkedFileWriter(outputFile);
  try {
    writer.write(`{"snapshot":${JSON.stringify(fileFaithfulHeader(raw))}`);
    for (const field of FIELD_ORDER) {
      writer.writeAscii(',\n');
      const value = (raw as unknown as Record<string, unknown>)[field];
      if (field === 'strings') {
        writeStringArrayField(writer, field, (value ?? []) as string[]);
      } else if (field === 'trace_tree') {
        writeTraceTreeField(writer, field, value);
      } else {
        writeNumericArrayField(
          writer,
          field,
          (value ?? []) as NumericArrayLike,
        );
      }
    }
    writer.writeAscii('}');
  } finally {
    writer.close();
  }
}

/**
 * Write a parsed (and possibly modified) heap snapshot to a `.heapsnapshot`
 * file that Chrome DevTools, memlab and any other V8 snapshot reader can open.
 *
 * This is the inverse of parsing, and it makes "load a snapshot, change it,
 * save it" a supported workflow — {@link anonymizeHeapSnapshot} is one such
 * consumer.
 *
 * Edits made through the snapshot's underlying data are picked up
 * automatically: node names are read out of the string table on every access
 * rather than cached, so a rewritten string table is already what the
 * in-memory snapshot reports.
 *
 * The file is streamed out through a single fixed buffer, one array element at
 * a time. That is a hard requirement rather than an optimization: V8 caps a
 * string at 512 MB (`buffer.constants.MAX_STRING_LENGTH`), so building the
 * document — or even one of its larger arrays — as a string throws
 * `RangeError: Invalid string length` on a large capture instead of merely
 * running slowly.
 *
 * @param snapshot the heap snapshot to write, as returned by
 * `getFullHeapFromFile` or {@link takeNodeMinimalHeap}
 * @param outputFile absolute path of the file to create; an existing file at
 * that path is overwritten
 * @returns this API returns void; the snapshot is written to `outputFile`
 *
 * * **Examples**:
 * ```typescript
 * import type {IHeapSnapshot} from '@memlab/core';
 * import {dumpNodeHeapSnapshot, serializeHeapSnapshot} from '@memlab/core';
 * import {getFullHeapFromFile} from '@memlab/heap-analysis';
 *
 * (async function () {
 *   const file = dumpNodeHeapSnapshot();
 *   const heap: IHeapSnapshot = await getFullHeapFromFile(file);
 *
 *   // ... modify the heap snapshot in memory ...
 *
 *   serializeHeapSnapshot(heap, '/tmp/modified.heapsnapshot');
 * })();
 * ```
 */
export function serializeHeapSnapshot(
  snapshot: IHeapSnapshot,
  outputFile: string,
): void {
  serializeRawHeapSnapshot(snapshot.snapshot, outputFile);
}
