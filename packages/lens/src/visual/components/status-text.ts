/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */
import {AnyValue} from '../../core/types';
import {
  RegisterDataUpdateCallback,
  VisualizerData,
} from '../dom-element-visualizer-interactive';
import {setVisualizerElement} from '../visual-utils';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function createStatusText(
  registerDataUpdateCallback: RegisterDataUpdateCallback,
): HTMLDivElement {
  const statusWidget = document.createElement('div');
  statusWidget.style.marginLeft = '10px';
  statusWidget.style.color = 'white';
  statusWidget.style.fontSize = '10px';
  statusWidget.style.fontFamily = 'Inter, system-ui, sans-serif';
  statusWidget.style.overflow = 'hidden';
  statusWidget.style.whiteSpace = 'nowrap';
  statusWidget.style.textOverflow = 'ellipsis';
  statusWidget.textContent = '';

  registerDataUpdateCallback((data: VisualizerData) => {
    const performance = (window as AnyValue).performance;
    const memory = performance?.memory;

    const usedHeap = memory?.usedJSHeapSize ?? 0;
    const totalHeap = memory?.totalJSHeapSize ?? 0;
    const totalElements = data.totalDOMElementsCount ?? 0;
    const detachedElements = data.detachedDOMElementsCount ?? 0;

    statusWidget.textContent =
      `DOM: ${totalElements} total, ${detachedElements} detached | ` +
      `Heap: ${formatBytes(usedHeap)} / ${formatBytes(totalHeap)}`;
  });

  setVisualizerElement(statusWidget);
  return statusWidget;
}
