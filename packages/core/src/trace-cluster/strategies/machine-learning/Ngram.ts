/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

export function nGram(n: number, terms: string[]) {
  const nGrams: string[] = [];
  let index = 0;
  while (index <= terms.length - n) {
    nGrams[index] = terms.slice(index, index + n).join(' ');
    ++index;
  }

  return nGrams;
}
