/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * V8 elements-backing-store primitives, in one place.
 *
 * Reading an object's elements store correctly needs five separate facts, and
 * each of them was got WRONG once before it was got right. They are stated here
 * so no tool has to rediscover them:
 *
 *   1. A plain `Object` with integer keys emits an `element` edge per non-hole
 *      slot ON THE OWNER, small-integer values included (they point at a shared
 *      `smi number` node).
 *   2. A `JSArray` frequently emits nothing on the owner and instead emits
 *      `internal` numeric edges ON THE STORE — but only for slots holding a
 *      heap object, so an all-SMI array reads as empty from there.
 *   3. Therefore, when both sides read zero the occupancy is UNKNOWABLE: a
 *      `new Array(34)` of holes and an array of 34 timestamps are byte-identical
 *      in a snapshot. Scoring those as empty ranked 4,301 all-SMI index arrays
 *      as the second-largest "finding" in one run.
 *   4. Capacity is `(storeBytes - 8) / slotBytes`, and `slotBytes` must be
 *      MEASURED. Wrong by 2x, it either invents slack that does not exist or
 *      classifies every dense store as a dictionary.
 *   5. `maxIndex + 1 > capacity` means dictionary mode, where a hole costs
 *      nothing and "waste" is not defined.
 */

import type {IHeapNode, IHeapSnapshot} from '@memlab/core';

/**
 * Bytes of the FixedArray header preceding the first slot. Same on a
 * pointer-compressed and an uncompressed heap (map + length), so only the slot
 * width has to be calibrated.
 */
export const STORE_HEADER_BYTES = 8;

/**
 * V8 grows an elements store to `n + (n >> 1) + kMinAddedElementsCapacity`,
 * with `kMinAddedElementsCapacity == 16`, so EVERY array built by `push`
 * carries up to 16 slots of tail slack no application change can remove.
 * Charging it turns a one-element array into a "94% empty" finding.
 *
 * https://github.com/v8/v8/blob/main/src/objects/js-objects.h
 */
export const FORGIVEN_TAIL_SLOTS = 16;

export type SlotBytes = 4 | 8;

export interface ElementsInfo {
  storeId: number;
  storeBytes: number;
  slotBytes: SlotBytes;
  /** Slots the backing store is sized for. */
  capacity: number;
  /** Slots holding a value. LOWER BOUND — see fact 3 above. */
  used: number;
  maxIndex: number;
  /** `maxIndex + 1` — how far into the store the written keys reach. */
  span: number;
  /** Interior holes: written keys are sparse within their own span. */
  holes: number;
  /** Raw tail slack past the last written key, before any forgiveness. */
  slack: number;
  mode: 'dense' | 'dictionary';
  /**
   * `false` when nothing readable is in the store — it may be all holes or all
   * small integers, and a snapshot cannot tell those apart. Callers must not
   * count these as waste.
   */
  measurable: boolean;
}

/** The raw two-sided read, before capacity is derived from a slot width. */
export interface RawElements {
  store: IHeapNode;
  /** Union occupancy: the owner's element edges are a superset of the store's. */
  used: number;
  maxIndex: number;
}

/** Read a node's elements store and its occupancy, or `null` if it has none. */
export function readRawElements(node: IHeapNode): RawElements | null {
  let store: IHeapNode | null = null;
  let ownerSlots = 0;
  let maxIndex = -1;
  for (const edge of node.references) {
    if (edge.type === 'element') {
      ownerSlots++;
      const index = Number(edge.name_or_index);
      if (index > maxIndex) maxIndex = index;
    } else if (
      edge.type === 'internal' &&
      String(edge.name_or_index) === 'elements'
    ) {
      store = edge.toNode;
    }
  }
  if (!store) return null;
  let storeSlots = 0;
  for (const edge of store.references) {
    const name = String(edge.name_or_index);
    // Numeric edge names on the store are slot indices; `map` and friends are
    // header fields, not contents.
    if (!/^\d+$/.test(name)) continue;
    storeSlots++;
    const index = Number(name);
    if (index > maxIndex) maxIndex = index;
  }
  return {store, used: Math.max(ownerSlots, storeSlots), maxIndex};
}

/**
 * Decide the slot width from evidence rather than assumption.
 *
 * A store whose largest written index fits in `(bytes - 8) / 4` slots but NOT
 * in `(bytes - 8) / 8` can only be 4-byte-slotted. Dictionary-mode stores
 * overflow both, so they cannot fake the signal. Pass any collection of
 * observed `(storeBytes, maxIndex)` pairs; one witness is enough, and a real
 * browser capture produces thousands.
 */
export function calibrateSlotBytes(
  samples: Iterable<{storeBytes: number; maxIndex: number}>,
): SlotBytes {
  for (const s of samples) {
    const slots = s.maxIndex + 1;
    if (slots <= 0) continue;
    const at8 = (s.storeBytes - STORE_HEADER_BYTES) / 8;
    const at4 = (s.storeBytes - STORE_HEADER_BYTES) / 4;
    if (slots > at8 && slots <= at4) return 4;
  }
  // Default to 4: every browser capture is pointer-compressed, and a heap with
  // no witness either way is one where the difference changes no ranking.
  return 4;
}

/** Witnesses needed before the scan stops early; more than enough to be sure. */
const CALIBRATION_WITNESSES = 32;

const slotBytesBySnapshot = new WeakMap<IHeapSnapshot, SlotBytes>();

/**
 * Memoized per-snapshot slot width for tools that do not already make their own
 * pass. Stops as soon as it has enough witnesses, so on a real heap it reads a
 * small prefix rather than the whole graph.
 */
export function getSlotBytes(snapshot: IHeapSnapshot): SlotBytes {
  const cached = slotBytesBySnapshot.get(snapshot);
  if (cached != null) return cached;
  const samples: Array<{storeBytes: number; maxIndex: number}> = [];
  snapshot.nodes.forEach(node => {
    // `false` is memlab's documented stop signal for this walk; a bare `return`
    // only skips the current node, so returning undefined here kept iterating
    // all 7M nodes of a large capture long after the 32nd witness. Every other
    // `return` below is a per-node skip and must stay undefined.
    if (samples.length >= CALIBRATION_WITNESSES) return false;
    if (
      node.type !== 'object' &&
      node.type !== 'array' &&
      node.type !== 'hidden'
    )
      return;
    const raw = readRawElements(node);
    if (!raw || raw.maxIndex < 0) return;
    const bytes = raw.store.self_size;
    if (bytes <= STORE_HEADER_BYTES) return;
    const slots = raw.maxIndex + 1;
    // Only witnesses that DISCRIMINATE are worth collecting.
    if (slots > (bytes - STORE_HEADER_BYTES) / 8) {
      samples.push({storeBytes: bytes, maxIndex: raw.maxIndex});
    }
  });
  const resolved = calibrateSlotBytes(samples);
  slotBytesBySnapshot.set(snapshot, resolved);
  return resolved;
}

/** Derive the full picture from a raw read and a slot width. */
export function describeElements(
  raw: RawElements,
  slotBytes: SlotBytes,
): ElementsInfo | null {
  const storeBytes = raw.store.self_size;
  if (storeBytes <= STORE_HEADER_BYTES) return null;
  const capacity = Math.floor((storeBytes - STORE_HEADER_BYTES) / slotBytes);
  const span = raw.maxIndex + 1;
  const dictionary = span > capacity;
  return {
    storeId: raw.store.id,
    storeBytes,
    slotBytes,
    capacity,
    used: raw.used,
    maxIndex: raw.maxIndex,
    span,
    holes: dictionary ? 0 : Math.max(0, span - raw.used),
    slack: dictionary ? 0 : Math.max(0, capacity - span),
    mode: dictionary ? 'dictionary' : 'dense',
    measurable: raw.used > 0,
  };
}

/**
 * Every node that owns an elements store, as parallel typed arrays.
 *
 * Built once per snapshot and memoized. Four tools ask the same structural
 * questions of the same nodes (does this own an elements store? how many
 * element edges? what is the largest index? how big is the store?), and each
 * was paying its own full pass — on a 7.1M-node / 41.7M-edge capture that is
 * the dominant cost of the call, and tuning one tool's parameters re-pays it
 * every time.
 *
 * Typed arrays rather than objects: on the capture above this is ~370k entries,
 * which is 6 MB as four typed arrays and several times that as objects. The
 * index is keyed by the snapshot, so a `keep_previous` A/B keeps one per arm and
 * both are released when the snapshot is.
 */
export interface ElementsIndex {
  /**
   * Node ids that own an elements store, ascending by scan order.
   *
   * Unsigned: ids, byte counts and occupancies cannot be negative, and a
   * signed 32-bit lane wraps anything past 2^31-1 to a negative number. For
   * `ownerIds` that failure is silent rather than loud — `getNodeById(-…)`
   * returns null, so the entry is skipped by every consumer instead of
   * throwing. `maxIndex` stays signed because -1 is its "the store holds no
   * numeric slot" sentinel, and a real element index above 2^31-1 would need a
   * sparse array indexed past two billion.
   *
   * The unsigned lanes have their own ceiling at 2^32-1, and it is assumed
   * rather than checked: V8 hands out snapshot node ids by increment, so
   * exceeding it means one isolate allocated over four billion objects — far
   * past the point where the snapshot itself is loadable here. A capture that
   * did would truncate an id and quietly drop that entry, so if this ever needs
   * to hold arbitrarily large captures, widen to `Float64Array` (ids stay exact
   * to 2^53) rather than adding a guard.
   */
  ownerIds: Uint32Array;
  storeBytes: Uint32Array;
  used: Uint32Array;
  maxIndex: Int32Array;
  slotBytes: SlotBytes;
  count: number;
}

const elementsIndexBySnapshot = new WeakMap<IHeapSnapshot, ElementsIndex>();

export function getElementsIndex(snapshot: IHeapSnapshot): ElementsIndex {
  const cached = elementsIndexBySnapshot.get(snapshot);
  if (cached != null) return cached;

  const ownerIds: number[] = [];
  const storeBytes: number[] = [];
  const used: number[] = [];
  const maxIndex: number[] = [];
  snapshot.nodes.forEach(node => {
    if (
      node.type !== 'object' &&
      node.type !== 'array' &&
      node.type !== 'hidden'
    ) {
      return;
    }
    const raw = readRawElements(node);
    if (!raw) return;
    const bytes = raw.store.self_size;
    if (bytes <= STORE_HEADER_BYTES) return;
    ownerIds.push(node.id);
    storeBytes.push(bytes);
    used.push(raw.used);
    maxIndex.push(raw.maxIndex);
  });

  const index: ElementsIndex = {
    ownerIds: Uint32Array.from(ownerIds),
    storeBytes: Uint32Array.from(storeBytes),
    used: Uint32Array.from(used),
    maxIndex: Int32Array.from(maxIndex),
    // Calibrating from the entries just collected costs nothing extra and is
    // strictly better evidence than the early-exit prefix scan.
    slotBytes: calibrateSlotBytes(
      ownerIds.map((_, i) => ({
        storeBytes: storeBytes[i],
        maxIndex: maxIndex[i],
      })),
    ),
    count: ownerIds.length,
  };
  elementsIndexBySnapshot.set(snapshot, index);
  slotBytesBySnapshot.set(snapshot, index.slotBytes);
  return index;
}

/** One-shot read for a single node, calibrating the snapshot if needed. */
export function readElements(
  snapshot: IHeapSnapshot,
  node: IHeapNode,
): ElementsInfo | null {
  const raw = readRawElements(node);
  if (!raw) return null;
  return describeElements(raw, getSlotBytes(snapshot));
}
