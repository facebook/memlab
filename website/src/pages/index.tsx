/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */

import React, {ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

interface FeatureItem {
  title: string;
  imageUrl: string;
  description: ReactNode;
}

const features: FeatureItem[] = [
  {
    title: 'Define Your Test',
    imageUrl: 'img/undraw_split_testing.svg',
    description: (
      <>
        Define your custom E2E tests scenarios that will be used for detecting
        memory leaks.
      </>
    ),
  },
  {
    title: 'Run memlab',
    imageUrl: 'img/undraw_online_test.svg',
    description: (
      <>
        Run memlab's <code>cli</code> tool with your your test scenarios. CLI
        will output the memory leaks if there is any.
      </>
    ),
  },
  {
    title: 'Analzye the Leaks',
    imageUrl: 'img/undraw_analyze.svg',
    description: (
      <>
        If there is a leak, it will output the leak traces. Each trace will be a
        list of chain of object references from Root to leaked object
      </>
    ),
  },
];

function Feature({imageUrl, title, description}) {
  const imgUrl = useBaseUrl(imageUrl);
  return (
    <div className={clsx('col col--4', styles.feature)}>
      {imgUrl && (
        <div className="text--center">
          <img className={styles.featureImage} src={imgUrl} alt={title} />
        </div>
      )}
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();

  return (
    <Layout
      title={`${siteConfig.title}`}
      description="memlab is an integrated E2E testing + memory leak detection + debugging framework for dealing with memory leaks in front-end JavaScript.">
      <header className={clsx('hero hero--primary', styles.heroBanner)}>
        <div className="container">
          <h1 className="hero__title">{siteConfig.title}</h1>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <div className={styles.buttons}>
            <Link
              className={clsx(
                'button button--outline button--secondary button--lg',
                styles.getStarted,
              )}
              to={useBaseUrl('docs/intro')}>
              Learn more
            </Link>
          </div>
        </div>
      </header>
      <main>
        {features && features.length > 0 && (
          <section className={styles.features}>
            <div className="container">
              <div className="row">
                {features.map(({title, imageUrl, description}) => (
                  <Feature
                    key={title}
                    title={title}
                    imageUrl={imageUrl}
                    description={description}
                  />
                ))}
              </div>
            </div>
          </section>
        )}
      </main>
    </Layout>
  );
}
