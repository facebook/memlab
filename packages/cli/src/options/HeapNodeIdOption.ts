/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
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
