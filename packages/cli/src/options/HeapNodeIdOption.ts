/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import type {ParsedArgs} from 'minimist';
import type {MemLabConfig} from '@memlab/core';
import {BaseOption} from '@memlab/core';

export default class HeapNodeIdOption extends BaseOption {
  getOptionName(): string {
    return 'nodeId';
  }

  getDescription(): string {
    return 'set heap node ID';
  }

  getExampleValues(): string[] {
    return ['14123123', '@14123123'];
  }

  async parse(config: MemLabConfig, args: ParsedArgs): Promise<void> {
    if (args[this.getOptionName()]) {
      if (!args.nodeId) {
        return;
      }
      if (typeof args.nodeId === 'string' && args.nodeId.startsWith('@')) {
        args.nodeId = args.nodeId.slice(1);
      }
      config.focusFiberNodeId = Number(args.nodeId);
    }
  }
}
