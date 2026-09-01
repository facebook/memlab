/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * The version this server reports about itself.
 *
 * Kept in its own module so `memlab_server_status` can report it without
 * importing `index.ts` (which would be an import cycle — index imports every
 * tool). Keep in sync with `package.json`; `scripts/check-version-sync.mjs`
 * enforces that.
 */
export const SERVER_VERSION = '2.90.0';
