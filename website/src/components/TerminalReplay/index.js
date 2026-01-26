/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import _ from './css/styles.css';
import Terminal from './lib/Term';
import createTimeline from './lib/TimelineFactory';
import React, {useEffect, useState} from 'react';

function initializeTerminal(id) {
  const terminal = new Terminal({
    cols: 90,
    rows: 28,
    screenKeys: true,
  });

  terminal.open(document.querySelector(`#${id} .content`));
  return terminal;
}

let gid = 0;

const TerminalDemo = ({stdouts}) => {
  const [id] = useState(`terminal-${gid++}`);
  useEffect(() => {
    const terminal = initializeTerminal(id);
    const timeline = createTimeline(terminal, stdouts);
    timeline.play();
    return () => {
      timeline.pause();
    };
  }, [id, stdouts]);

  return (
    <div className="terminal-content">
      <div id={id} className="terminal-inner">
        <div xterm={true} className="content" />
      </div>
    </div>
  );
};

export default TerminalDemo;
