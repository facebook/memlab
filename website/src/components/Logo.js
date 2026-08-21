/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import styles from '../pages/styles.module.css';
import useBaseUrl from '@docusaurus/useBaseUrl';
import React from 'react';

const Logo = ({caption, imageUrl, infoUrl}) => {
  return (
    <a
      className={styles.showcaseLogo}
      href={infoUrl}
      rel="noreferrer noopener"
      target="_blank">
      <img alt={caption} src={useBaseUrl(imageUrl)} title={caption} />
    </a>
  );
};

export default Logo;
