/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import type {CommandOptionExample} from '@memlab/core';

type GenerateExampleCommandOption = {
  descriptionAsBashComment?: boolean;
};

function generateExampleCommand(
  command: string,
  cliExample: CommandOptionExample,
  options: GenerateExampleCommandOption = {},
): string {
  if (typeof cliExample === 'string') {
    return exampleFromCliOptionString(command, cliExample);
  }

  let commandExample = '';
  if (
    cliExample.description != null &&
    // if it's not null, undefined, or true
    options.descriptionAsBashComment !== false
  ) {
    // inject the description as a bash command in the bash example
    commandExample += `# ${cliExample.description.trim()}\n`;
  }
  commandExample += exampleFromCliOptionString(
    command,
    cliExample.cliOptionExample,
  );
  return commandExample;
}

function exampleFromCliOptionString(
  command: string,
  cliExample: string,
): string {
  return `memlab ${command} ${cliExample.trim()}`;
}

export default {
  generateExampleCommand,
};
