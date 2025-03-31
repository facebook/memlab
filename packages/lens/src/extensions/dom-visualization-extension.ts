/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import type ReactMemoryScan from '../core/react-memory-scan';
import type {AnalysisResult} from '../core/types';

import DOMElementVisualizer from '../visual/dom-element-visualizer';
import DOMElementVisualizerInteractive from '../visual/dom-element-visualizer-interactive';
import {BasicExtension} from './basic-extension';

const USE_INTERACTIVE_VISUALIZER = true;

export class DOMVisualizationExtension extends BasicExtension {
  #domVirtualizer: DOMElementVisualizer;

  constructor(scanner: ReactMemoryScan) {
    super(scanner);
    if (USE_INTERACTIVE_VISUALIZER) {
      this.#domVirtualizer = new DOMElementVisualizerInteractive();
    } else {
      this.#domVirtualizer = new DOMElementVisualizer();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  afterScan(_analysisResult: AnalysisResult): void {
    // const start = Date.now();
    const scanner = this.scanner;
    if (scanner.isDevMode()) {
      const detachedDOMInfo = scanner.getDetachedDOMInfo();
      this.#domVirtualizer.repaint(detachedDOMInfo);
    }
    // const end = Date.now();
    // console.log(`repaint took ${end - start}ms`);
  }
}
