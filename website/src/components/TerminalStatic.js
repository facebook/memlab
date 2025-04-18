/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import Highlight, {defaultProps} from 'prism-react-renderer';
import theme from 'prism-react-renderer/themes/palenight';
import React from 'react';

const TerminalStatic = ({code, language}) => (
  <Highlight {...defaultProps} code={code} language={language} theme={theme}>
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

export default TerminalStatic;
