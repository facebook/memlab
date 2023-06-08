/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */
import type {ParsedArgs} from 'minimist';
import type {AnyRecord, RecordValue} from '@memlab/core';

import stringWidth from 'string-width';
import {utils} from '@memlab/core';
import optionConstants from '../options/lib/OptionConstant';

const breakableSymbolOnRight = new Set([
  ' ',
  '\t',
  ',',
  '.',
  ':',
  ';',
  '!',
  '?',
  ')',
  ']',
  '}',
  '>',
]);
const breakableSymbolOnLeft = new Set([' ', '\t', '(', '[', '{', '<']);

export type BlockTextOption = {
  leftIndent?: number;
  lineLength?: number;
};

export const READABLE_CMD_FLAG_WIDTH = 70;
export const READABLE_TEXT_WIDTH = 150;

export function filterAndGetUndefinedArgs(cliArgs: ParsedArgs): AnyRecord {
  const ret = Object.create(null);
  const memlabFBOptionNames = new Set(
    Object.values({
      ...optionConstants.optionNames,
    }),
  );
  for (const optionName of Object.keys(cliArgs)) {
    if (optionName === '_') {
      continue;
    }
    if (memlabFBOptionNames.has(optionName)) {
      continue;
    }
    ret[optionName] = cliArgs[optionName];
  }
  return ret;
}

function quoteIfNecessary(v: RecordValue): RecordValue {
  if (typeof v !== 'string') {
    return v;
  }
  // if the string contains any whitespace character
  if (/\s/.test(v)) {
    // escape any existing " character
    v = v.replace(/"/g, '\\"');
    // wrap the string with "
    v = `"${v}"`;
  }
  return v;
}

export function argsToString(args: AnyRecord): string {
  let ret = '';
  for (const optionName of Object.keys(args)) {
    if (optionName === '_') {
      continue;
    }
    const value = args[optionName];
    if (value === true) {
      ret += `--${optionName} `;
    } else if (Array.isArray(value)) {
      value.forEach(v => {
        ret += `--${optionName}=${quoteIfNecessary(v)} `;
      });
    } else {
      ret += `--${optionName}=${quoteIfNecessary(value)} `;
    }
  }
  return ret.trim();
}

export function getBlankSpaceString(length: number): string {
  let ret = '';
  for (let i = 0; i < length; ++i) {
    ret += ' ';
  }
  return ret;
}

export function alignTextInBlock(
  text: string,
  options: BlockTextOption,
): string {
  const indent = options.leftIndent ?? 0;
  const maxLineWidth = Math.min(
    READABLE_TEXT_WIDTH,
    options.lineLength ?? process.stdout.columns,
  );
  if (indent < 0 || maxLineWidth <= 0 || indent >= maxLineWidth) {
    throw utils.haltOrThrow('invalid indent or maximum line width');
  }
  const indentString = getBlankSpaceString(indent);
  const inputLines = text.split('\n');
  const outputLines: string[] = [];
  while (inputLines.length > 0) {
    const line = inputLines.shift() as string;
    // if the current line can fit in cmd row
    if (stringWidth(indentString + line) <= maxLineWidth) {
      outputLines.push(indentString + line);
      continue;
    }
    // otherwise split the current line
    const intendedSplitPoint = maxLineWidth - indent;
    const splitLines = splitIntoReadableSubstrings(line, intendedSplitPoint);
    const [firstLine, restLine] = splitLines;
    outputLines.push(indentString + firstLine);
    inputLines.unshift(restLine);
  }
  return outputLines.join('\n');
}

function splitIntoReadableSubstrings(
  text: string,
  intendedSplitPoint: number,
): string[] {
  if (intendedSplitPoint >= text.length) {
    return [text];
  }
  let splitPoint = intendedSplitPoint;
  while (splitPoint > 0) {
    const ch = text[splitPoint];
    if (breakableSymbolOnLeft.has(ch)) {
      break;
    }
    if (
      splitPoint - 1 > 0 &&
      breakableSymbolOnRight.has(text[splitPoint - 1])
    ) {
      break;
    }
    --splitPoint;
  }
  if (splitPoint <= 0) {
    splitPoint = intendedSplitPoint;
  }
  // if the second line starts with a ' ',
  // skip the empty space
  const firstLine = text.substring(0, splitPoint);
  let secondLine = text.substring(splitPoint);
  if (secondLine.startsWith(' ')) {
    secondLine = secondLine.substring(1);
  }
  if (secondLine.length === 0) {
    return [firstLine];
  }
  return [firstLine, secondLine];
}
