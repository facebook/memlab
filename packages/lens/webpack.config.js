/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const path = require('path');

const createConfig = ({entry, filename, minimize}) => ({
  entry,
  output: {
    filename,
    path: path.resolve(__dirname, 'dist'),
    library: entry.lib
      ? {
          name: 'MemLens',
          type: 'umd',
        }
      : undefined,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  mode: 'production',
  optimization: {
    minimize,
  },
});

/** Export 4 builds: lib (min/non-min), run (min/non-min) */
module.exports = [
  createConfig({
    entry: {lib: './src/memlens.lib.ts'},
    filename: 'memlens.lib.bundle.js', // non-minified
    mode: 'production',
    minimize: false,
  }),
  createConfig({
    entry: {lib: './src/memlens.lib.ts'},
    filename: 'memlens.lib.bundle.min.js', // minified
    mode: 'production',
    minimize: true,
  }),
  createConfig({
    entry: {run: './src/memlens.run.ts'},
    filename: 'memlens.run.bundle.js', // non-minified
    mode: 'production',
    minimize: false,
  }),
  createConfig({
    entry: {run: './src/memlens.run.ts'},
    filename: 'memlens.run.bundle.min.js', // minified
    mode: 'production',
    minimize: true,
  }),
];
