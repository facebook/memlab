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

import Timeline from './Timeline';

export default function createTimeline(term, stdouts) {
  const totalTime = stdouts[stdouts.length - 1].time;
  const timeline = new Timeline({length: totalTime, frequency: 10});

  class Marker {
    constructor(time, content) {
      this.time = time;
      this.content = content;
    }
    forward() {
      term.write(this.content);
    }
  }

  for (let i = 0; i < stdouts.length; i++) {
    const {time, content} = stdouts[i];
    timeline.markers.push(new Marker(time, content));
  }
  return timeline;
}
