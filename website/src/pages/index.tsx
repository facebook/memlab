/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall web_perf_infra
 */

import React, { ReactNode, useLayoutEffect } from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import CodeBlock from '../components/CodeBlock';
import TerminalStatic from '../components/TerminalStatic';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';
import TerminalReplay from '../components/TerminalReplay';
import Showcase from '../components/Showcase';
import startAnimation from '../lib/ContainerAnimation';
import normalizeTypeSpeed from '../lib/TypeSpeedNormalization';
import homePageStdouts from '../data/HomePageMainTerminal';

interface FeatureItem { title: string; docUrl?: string; imageUrl?: string; description: ReactNode; }
const features: FeatureItem[] = [/* ... */];

const Feature = ({ imageUrl, title, description, docUrl }: FeatureItem) => (
  <div className={clsx('col col--4', styles.feature)}>
    {imageUrl && (
      <div className="text--center">
        <img className={styles.featureImage} src={useBaseUrl(imageUrl)} alt={title} />
      </div>
    )}
    {docUrl ? (
      <Link className={styles.titleLink} to={useBaseUrl(docUrl)}>
        <h3>{title}</h3>
      </Link>
    ) : (
      <h3>{title}</h3>
    )}
    <p>{description}</p>
  </div>
);

const stdouts = normalizeTypeSpeed(homePageStdouts);

const Home = (): React.ReactElement => {
  const { siteConfig } = useDocusaurusContext();
  const headerContainerID = 'css-animated-bg-container';

  useLayoutEffect(() => startAnimation(headerContainerID), []);

  return (
    <Layout description="memlab is an E2E testing, memory leak detection, and heap analysis framework for front-end JavaScript.">
      <header id={headerContainerID} className={clsx('hero hero--primary', styles.heroBanner)}>
        <div id="header-container" className="container">
          <div id="left-header-section" className="container-section">
            <h1 id="title" className="hero__title">{siteConfig.title}</h1>
            <p id="sub-title" className="hero__subtitle">{siteConfig.tagline}</p>
            <div className={styles.buttons}>
              <Link id="learn-more" className={clsx('button button--outline button--secondary button--lg', styles.getStarted)} to={useBaseUrl('docs/getting-started')}>Learn more</Link>
            </div>
          </div>
          <div className="container-section">
            <TerminalReplay stdouts={stdouts} />
          </div>
        </div>
      </header>

      <main>
        {features && features.length > 0 && (
          <section className={styles.features}>
            <div className="container">
              <div className="row">
                {features.map(({ title, docUrl, imageUrl, description }) => (
                  <Feature
                    key={title}
                    title={title}
                    docUrl={useBaseUrl(docUrl)}
                    imageUrl={useBaseUrl(imageUrl)}
                    description={description}
                  />
                ))}
              </div>
            </div>
          </section>
        )}
        <Showcase />
      </main>
    </Layout>
  );
};

export default Home;
