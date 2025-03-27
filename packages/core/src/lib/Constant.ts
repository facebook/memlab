/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import {setInternalValue} from './InternalValueSetter';

const constants = {
  isFB: false,
  isFRL: false,
  defaultEngine: 'V8',
  supportedEngines: ['V8', 'hermes'],
  supportedBrowsers: Object.create(null),
  internalDir: 'fb-internal',
  monoRepoDir: '',
  defaultUserAgent: 'default',
  defaultProtocolTimeout: 5 * 60 * 1000,
  V8SyntheticRoots: [
    '(GC roots)',
    '(Internalized strings)',
    '(External strings)',
    '(Read-only roots)',
    '(Strong roots)',
    '(Smi roots)',
    '(Bootstrapper)',
    '(Stack roots)',
    '(Relocatable)',
    '(Debugger)',
    '(Compilation cache)',
    '(Handle scope)',
    '(Builtins)',
    '(Global handles)',
    '(Eternal handles)',
    '(Thread manager)',
    '(Strong roots)',
    '(Extensions)',
    '(Code flusher)',
    '(Startup object cache)',
    '(Read-only object cache)',
    '(Weak collections)',
    '(Wrapper tracing)',
    '(Write barrier)',
    '(Retain maps)',
    '(Unknown)',
    '<Synthetic>',
  ],
  namePrefixForScenarioFromFile: '',
  unset: 'UNSET',
};

Object.assign(constants.supportedBrowsers, {
  chromium: 'chrome',
  chrome: 'google-chrome',
});

export type Constants = typeof constants;
export default setInternalValue(constants, __filename, constants.internalDir);
