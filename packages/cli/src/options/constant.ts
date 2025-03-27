/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

export const OptionNames = {
  DEBUG: 'debug',
  HELP: 'help',
  ML_LINKAGE_MAX_DIST: 'ml-linkage-max-dist',
  ML_CLUSTERING_MAX_DF: 'ml-clustering-max-df',
  ML_CLUSTERING: 'ml-clustering',
  RUN_NUM: 'run-num',
  SC: 'sc',
  CONTINUS_TEST: 'ContinuousTest',
  WORK_DIR: 'work-dir',
  SILENT: 'silent',
  VERBOSE: 'verbose',
  LEAK_FILTER: 'leak-filter',
  BASELINE: 'baseline',
  FINAL: 'final',
  NODE_ID: 'node-id',
  ENGINE: 'engine',
  IGNORE_LEAK_CLUSTER_SIZE_BELOW: 'ignore-leak-cluster-size-below',
  SAVE_TRACE_AS_UNCLASSIFIED_CLUSTER: 'save-trace-as-unclassified-cluster',
  TRACE_OBJECT_SIZE_ABOVE: 'trace-object-size-above',
  SNAPSHOT_DIR: 'snapshot-dir',
  SNAPSHOT: 'snapshot',
  TARGET: 'target',
  TRACE_ALL_OBJECTS: 'trace-all-objects',
  APP: 'app',
  DISABLE_WEB_SECURITY: 'disable-web-security',
  DISABLE_XVFB: 'disable-xvfb',
  REWRITE_JS: 'rewrite-js',
  FULL: 'full',
  HEADFUL: 'headful',
  INTERACTION: 'interaction',
  LOCAL_PUPPETEER: 'local-puppeteer',
  RUN_MODE: 'run-mode',
  SCENARIO: 'scenario',
  DEVICE: 'device',
  USER_AGENT: 'user-agent',
  SKIP_EXTRA_OPS: 'skip-extra-ops',
  SKIP_EXTRA_OP: 'skip-extra-op',
  SKIP_GC: 'skip-gc',
  SKIP_SCREENSHOT: 'skip-screenshot',
  SKIP_SCROLL: 'skip-scroll',
  SKIP_SNAPSHOT: 'skip-snapshot',
  SKIP_WARMUP: 'skip-warmup',
};

export const OptionShortcuts = {
  H: 'h',
  S: 's',
  V: 'v',
};
