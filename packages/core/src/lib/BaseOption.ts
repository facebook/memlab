/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import type {ParsedArgs} from 'minimist';
import type {AnyRecord} from './Types';

import utils from './Utils';
import {MemLabConfig} from './Config';

abstract class Option {
  private optionalFlag = true;

  // option long name, e.g., --verbose
  getOptionName(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getOptionName is not implemented`);
  }

  // option shortcut, e.g., -v
  getOptionShortcut(): string | null {
    const className = this.constructor.name;
    throw new Error(`${className}.getOptionShortcut is not implemented`);
  }

  protected async parse(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: MemLabConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: ParsedArgs,
  ): Promise<AnyRecord | void> {
    const className = this.constructor.name;
    throw new Error(`${className}.parse is not implemented`);
  }

  // DO NOT OVERRIDE
  async run(config: MemLabConfig, args: ParsedArgs): Promise<AnyRecord | void> {
    // check presence of required flag
    if (!this.optionalFlag) {
      const keys = new Set(Object.keys(args));
      if (!keys.has(this.getOptionName())) {
        const shortcut = this.getOptionShortcut();
        if (!shortcut || !keys.has(shortcut)) {
          utils.haltOrThrow(
            `command line argument --${this.getOptionName()} is required`,
          );
        }
      }
    }
    return await this.parse(config, args);
  }

  optional(): BaseOption {
    this.optionalFlag = true;
    return this as unknown as BaseOption;
  }

  required(): BaseOption {
    this.optionalFlag = false;
    return this as unknown as BaseOption;
  }

  isOptional(): boolean {
    return this.optionalFlag;
  }
}

export default class BaseOption extends Option {
  // option long name, e.g., --verbose
  getOptionName(): string {
    const className = this.constructor.name;
    throw utils.haltOrThrow(`${className}.getCommandName is not implemented`);
  }

  // option shortcut, e.g., -v
  getOptionShortcut(): string | null {
    return null;
  }

  // get a list of example values
  // examples will be displayed in helper text
  getExampleValues(): string[] {
    return [];
  }

  // description of this option (printed in helper text)
  getDescription(): string {
    const className = this.constructor.name;
    throw new Error(`${className}.getDescription is not implemented`);
  }

  // Do the memory analysis and print results in this callback
  protected async parse(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: MemLabConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _args: ParsedArgs,
  ): Promise<AnyRecord | void> {
    const className = this.constructor.name;
    throw new Error(`${className}.parse is not implemented`);
  }
}
