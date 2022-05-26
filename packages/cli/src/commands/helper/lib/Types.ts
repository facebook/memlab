/**
 * Copyright (c) Facebook, Inc. and its affiliates. All Rights Reserved.
 *
 * @format
 */

import BaseCommand, {CommandCategory} from '../../../BaseCommand';

export type CommandOrderItem = {
  category: CommandCategory;
  commands: BaseCommand[];
};

export type CommandOrder = Array<CommandOrderItem>;
