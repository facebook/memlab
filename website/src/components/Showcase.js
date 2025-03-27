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
import Logo from './Logo';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import classnames from 'classnames';
import React from 'react';

const Showcase = () => {
  const {siteConfig = {}} = useDocusaurusContext();
  const {users} = siteConfig.customFields;
  const showcase = users.map((user, i) => {
    return (
      <Logo
        i={i}
        infoUrl={user.infoUrl}
        imageUrl={user.imageUrl}
        caption={user.caption}
      />
    );
  });

  return (
    <section className={classnames('text--center', styles.showcase)}>
      <h2
        className={classnames(
          'showcaseHeading',
          styles.showcaseHeadingColored,
        )}>
        Who's using memlab?
      </h2>
      <div className={styles.showcaseLogos}>{showcase}</div>
      {siteConfig.customFields.showAddLogoButton && (
        <div className="more-users">
          <Link
            className={classnames(
              'button button--primary button--outline',
              styles.button,
            )}
            href="https://github.com/facebook/memlab/edit/main/website/docusaurus.config.js">
            Add your company/project here
          </Link>
        </div>
      )}
    </section>
  );
};

export default Showcase;
