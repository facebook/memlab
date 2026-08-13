/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// Files in this directory are npm `bin` entry points: package.json declares
// them as executables, so POSIX requires `#!/usr/bin/env node` on line 1.
//
// `fb-www/docblock-first` treats anything preceding the file docblock as
// disqualifying, and the shebang counts — verified by removing it, at which
// point the rule stops firing. The two requirements are therefore mutually
// exclusive for this directory, and the rule's stated rationale (ESLint skips
// pragma parsing, producing spurious no-undef errors for Flow utility types)
// does not apply: these are plain CommonJS/ESM Node scripts with no Flow types.
//
// Scoped to bin/ so the rule keeps applying to every other file in the package.
module.exports = {
  rules: {
    'fb-www/docblock-first': 'off',
  },
};
