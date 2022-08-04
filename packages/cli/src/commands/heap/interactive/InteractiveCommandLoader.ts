/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import BaseCommand from '../../../BaseCommand';
import CommandLoader from '../../../CommandLoader';
import HelperCommand from '../../helper/HelperCommand';
import GetRetainerTraceCommand from '../GetRetainerTraceCommand';

import RunHeapAnalysisCommand from '../HeapAnalysisCommand';

const commandToInclude = new Set<typeof BaseCommand>([
  RunHeapAnalysisCommand,
  GetRetainerTraceCommand,
  HelperCommand,
]);

export default class InteractiveCommandLoader extends CommandLoader {
  protected shouldRegisterCommand(command: BaseCommand) {
    const constructor = command.constructor as typeof BaseCommand;
    return commandToInclude.has(constructor);
  }

  protected postRegistration(): void {
    // do nothing
  }
}
