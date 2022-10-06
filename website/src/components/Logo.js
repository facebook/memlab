/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import styles from '../pages/styles.module.css';
import useBaseUrl from '@docusaurus/useBaseUrl';
import React from 'react';

const Logo = ({i, infoUrl, imageUrl, caption}) => {
  return (
    <a key={i} className={styles.showcaseLogo} href={infoUrl}>
      <img src={useBaseUrl(imageUrl)} title={caption} />
    </a>
  );
};

export default Logo;
