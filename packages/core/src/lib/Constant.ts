/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */
import {setInternalValue} from './InternalValueSetter';

const constants = {
  isFB: false,
  isFRL: false,
  defaultEngine: 'v8',
  supportedEngines: ['v8', 'hermes'],
  supportedBrowsers: Object.create(null),
  internalDir: 'fb-internal',
  monoRepoDir: '',
  defaultUserAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2)' +
    ' AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.0 Safari/537.36',
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
