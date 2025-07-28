/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

// all characters that need SHIFT to be pressed first
const shiftCharacters = new Set('~!@#$%^&*()_+{}:"<>?|'.split(''));

/**
 * normalize the typing speed and make the type input feel more natural
 */
module.exports = function normalizeTypeSpeed(events, speedFactor = 1) {
  const deltas = [0];
  for (let i = 1; i < events.length; ++i) {
    deltas[i] = events[i].time - events[i - 1].time;
    const content = events[i].content;

    // if this event has a manually defined time
    // gap to the previous event
    if ('timeGapFromPreviousStep' in events[i]) {
      deltas[i] = events[i].timeGapFromPreviousStep;

      // if this is an "Enter" hit by user input
    } else if (content === '\r\n' && events[i - 1].content.length === 1) {
      // if the "Enter" is ending a comment (starts with a "#")
      // and the next line is also a comment
      if (i + 2 < events.length && events[i + 2].content === '#') {
        deltas[i] = 600;
      } else {
        deltas[i] = 1000;
      }

      // speed up the empty space, which feels more natural
    } else if (content === ' ') {
      deltas[i] = 30;

      // if repeatedly typing the same letter, it should be faster
    } else if (content.length === 1 && content === events[i - 1].content) {
      deltas[i] = 90;

      // randomize the type speed a little to feel less like a machine
    } else if (content.length === 1) {
      // eslint-disable-next-line fb-www/unsafe-math-random
      deltas[i] = 110 + Math.random(0, 40);

      // characters that needs more than 1 keystroke to type
      if (shiftCharacters.has(content)) {
        // eslint-disable-next-line fb-www/unsafe-math-random
        deltas[i] += 70 + Math.random(0, 20);
      }
    }
  }

  for (let i = 1; i < events.length; ++i) {
    events[i].time = events[i - 1].time + Math.floor(deltas[i] / speedFactor);
  }
  return events;
};
