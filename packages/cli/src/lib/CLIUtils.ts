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
import type {AnyRecord} from '@memlab/core';

import optionConstants from '../options/lib/OptionConstant';

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

export function argsToString(args: AnyRecord): string {
  let ret = '';
  for (const optionName of Object.keys(args)) {
    if (optionName === '_') {
      continue;
    }
    if (args[optionName] === true) {
      ret += `--${optionName} `;
    } else {
      ret += `--${optionName}=${args[optionName]} `;
    }
  }
  return ret.trim();
}
