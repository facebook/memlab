/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

/**
 * normalize the typing speed and make the type input feel more natural
 */
module.exports = function nomralizeTypeSpeed(events) {
  const deltas = [0];
  for (let i = 1; i < events.length; ++i) {
    deltas[i] = events[i].time - events[i - 1].time;
    const content = events[i].content;

    // if this is an "Enter" hit by user input
    if (content === '\r\n' && events[i - 1].content.length === 1) {
      deltas[i] = 1000;

      // speed up the empty space, which feel more natural
    } else if (content === ' ') {
      deltas[i] = 50;

      // randomize the type speed a little to feel less like a machine
    } else if (content.length === 1) {
      // eslint-disable-next-line fb-www/unsafe-math-random
      deltas[i] = 120 + Math.random(0, 50);
    }
  }

  for (let i = 1; i < events.length; ++i) {
    events[i].time = events[i - 1].time + deltas[i];
  }
  return events;
};
