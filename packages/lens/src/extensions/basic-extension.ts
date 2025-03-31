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

/**
 * Base class for React Memory Scanner extensions.
 * Extensions can hook into the scanning process before and after analysis.
 */
export abstract class BasicExtension {
  protected readonly scanner: ReactMemoryScan;

  constructor(scanner: ReactMemoryScan) {
    this.scanner = scanner;
  }

  /**
   * Hook that runs before the memory scan starts.
   * Override this method to perform any setup or pre-scan operations.
   */
  beforeScan(): void {
    // to be overridden
  }

  /**
   * Hook that runs after the memory scan completes.
   * Override this method to process or modify the analysis results.
   * @param analysisResult - The results from the memory scan
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  afterScan(_analysisResult: AnalysisResult): void {
    // to be overridden
  }
}
