/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import BaseCommand, {CommandCategory} from '../../../BaseCommand';

export type CommandOrderItem = {
  category: CommandCategory;
  commands: BaseCommand[];
};

export type CommandOrder = Array<CommandOrderItem>;
