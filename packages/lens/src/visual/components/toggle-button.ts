/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {setVisualizerElement} from '../visual-utils';

export function createToggleButton(
  overlayDiv: HTMLDivElement,
  hideAllRef: {value: boolean},
): HTMLDivElement {
  const toggleWrapper = document.createElement('div');
  toggleWrapper.style.width = '40px';
  toggleWrapper.style.height = '24px';
  toggleWrapper.style.borderRadius = '9999px';
  toggleWrapper.style.backgroundColor = '#34C759'; // ON by default
  toggleWrapper.style.cursor = 'pointer';
  toggleWrapper.style.position = 'relative';
  toggleWrapper.style.transition = 'background-color 0.3s ease';
  setVisualizerElement(toggleWrapper);

  const knob = document.createElement('div');
  knob.style.width = '18px';
  knob.style.height = '18px';
  knob.style.backgroundColor = 'white';
  knob.style.borderRadius = '50%';
  knob.style.position = 'absolute';
  knob.style.top = '3px';
  knob.style.left = '3px'; // ON position
  knob.style.transition = 'left 0.25s ease';
  toggleWrapper.appendChild(knob);

  toggleWrapper.addEventListener('click', () => {
    hideAllRef.value = !hideAllRef.value;

    if (hideAllRef.value) {
      // OFF state
      overlayDiv.style.display = 'none';
      overlayDiv.style.pointerEvents = 'none';
      overlayDiv.style.userSelect = 'none';
      knob.style.left = '19px';
      toggleWrapper.style.backgroundColor = '#FF3B30'; // Apple red
    } else {
      // ON state
      overlayDiv.style.display = 'block';
      overlayDiv.style.pointerEvents = 'auto';
      overlayDiv.style.userSelect = 'auto';
      knob.style.left = '3px';
      toggleWrapper.style.backgroundColor = '#34C759'; // Apple green
    }
  });

  return toggleWrapper;
}
