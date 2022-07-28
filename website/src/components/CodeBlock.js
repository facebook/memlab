/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 * @oncall ws_labs
 */

import {useColorMode} from '@docusaurus/theme-common';
import Highlight, {defaultProps} from 'prism-react-renderer';
import palenight from 'prism-react-renderer/themes/palenight';
import vsLight from 'prism-react-renderer/themes/vsLight';
import React from 'react';

const CodeBlock = ({code, language}) => {
  const {colorMode} = useColorMode();
  return (
    <Highlight
      {...defaultProps}
      code={code}
      language={language}
      theme={colorMode === 'dark' ? palenight : vsLight}>
      {({className, getLineProps, getTokenProps, style, tokens}) => (
        <pre className={className} style={{...style, textAlign: 'left'}}>
          {tokens.map((line, i) => (
            <div {...getLineProps({line, key: i})}>
              {line.map((token, key) => (
                <span {...getTokenProps({token, key})} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
};

export default CodeBlock;
