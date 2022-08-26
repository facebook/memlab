/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall ws_labs
 */

import {Page} from 'puppeteer';
import {utils} from '@memlab/core';
import type {AnyValue} from '@memlab/core';
import BaseOperation from './BaseOperation';

type OperationFactory = (memCache: Record<string, AnyValue>) => BaseOperation;

/**
 * Supply a factory function that produces an operation, and this operation will
 * supply the memory cache to it. Use this in cases where you want the inner
 * operation to be customizable based on some piece of cached content (eg. the
 * URL of a post permalink created in an earlier step).
 */
class WithCachedPageContent extends BaseOperation {
  operationFactory: OperationFactory;
  constructor(operationFactory: OperationFactory) {
    super();
    this.operationFactory = operationFactory;
  }

  async act(page: Page): Promise<void> {
    const operationFactory = this.operationFactory;
    if (!operationFactory) {
      utils.haltOrThrow(
        'WithCachedPageContent: Must provide a function that returns an ' +
          'operation',
      );
    }
    const operation = operationFactory(utils.memCache);
    if (!operation || typeof operation.act != 'function') {
      utils.haltOrThrow(
        'WithCachedPageContent: Value returned from the operation factory ' +
          'function must be an object with an `act` method.',
      );
    }
    await operation.act(page);
  }
}

export default WithCachedPageContent;
