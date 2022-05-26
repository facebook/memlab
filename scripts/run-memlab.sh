#!/bin/bash

scriptDir="$( cd "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )"
projectBaseDir="${scriptDir}/.."

# running in OSS
nodeModuleDir="${projectBaseDir}/node_modules"
nodeBin=`which node`

LD_LIBRARY_PATH=${chromeBinaryDir} \
  NODE_PATH=${nodeModuleDir} ${nodeBin} \
  --expose-gc \
  --max-old-space-size=4096 \
  ${projectBaseDir}/packages/cli/dist/runner.js $@
