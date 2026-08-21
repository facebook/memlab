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
import palenight from 'prism-react-renderer/themes/palenight';
import React from 'react';

const CodeBlock = ({code, language}) => {
  // always rendered on the dark palenight theme so the landing page code
  // samples read the same in light and dark mode
  return (
    <Highlight
      {...defaultProps}
      code={code}
      language={language}
      theme={palenight}>
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
