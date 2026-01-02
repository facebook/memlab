/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
const fs = require('fs');
const path = require('path');

const copyrightHeader = getHeaderBanner();

function getHeaderBanner() {
  const licensePath = path.resolve(__dirname, 'LICENSE');
  try {
    if (fs.existsSync(licensePath)) {
      const content = fs.readFileSync(licensePath, {encoding: 'utf8'});
      const lines = content.split(/\r?\n/);
      lines.unshift('@license MemLab');
      const commented = lines.map(line => ` * ${line}`).join('\n');
      return `/**\n${commented}\n */\n`;
    }
  } catch {
    // ignore errors
  }
  return '';
}

class InjectHeaderPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tapAsync('MyPlugin', (compilation, callback) => {
      const outputPath = compiler.outputPath; // absolute directory path
      for (const asset of compilation.getAssets()) {
        if (!asset.name.endsWith('.js')) {
          continue;
        }
        const filePath = path.join(outputPath, asset.name);
        const content = fs.readFileSync(filePath, {encoding: 'utf8'});
        fs.writeFileSync(filePath, `${copyrightHeader}${content}`, {
          encoding: 'utf8',
        });
      }
      callback();
    });
  }
}

const createConfig = ({entry, filename, minimize, plugins}) => ({
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
  plugins,
});

const createNodeConfig = ({entry, filename, minimize}) => ({
  entry,
  output: {
    filename,
    path: path.resolve(__dirname, 'dist'),
    library: {
      type: 'commonjs2',
    },
  },
  target: 'node',
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
  externals: {
    fs: 'commonjs fs',
    path: 'commonjs path',
  },
});

/** Export 4 builds: lib (min/non-min), run (min/non-min) */
module.exports = [
  createConfig({
    entry: {lib: './src/memlens.lib.ts'},
    filename: 'memlens.lib.bundle.js', // non-minified
    mode: 'production',
    minimize: false,
    plugins: [new InjectHeaderPlugin()],
  }),
  createConfig({
    entry: {lib: './src/memlens.lib.ts'},
    filename: 'memlens.lib.bundle.min.js', // minified
    mode: 'production',
    minimize: true,
    plugins: [new InjectHeaderPlugin()],
  }),
  createConfig({
    entry: {run: './src/memlens.run.ts'},
    filename: 'memlens.run.bundle.js', // non-minified
    mode: 'production',
    minimize: false,
    plugins: [new InjectHeaderPlugin()],
  }),
  createConfig({
    entry: {run: './src/memlens.run.ts'},
    filename: 'memlens.run.bundle.min.js', // minified
    mode: 'production',
    minimize: true,
    plugins: [new InjectHeaderPlugin()],
  }),
  createNodeConfig({
    entry: {index: './src/index.ts'},
    filename: 'index.js',
    minimize: false,
  }),
];
