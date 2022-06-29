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
import CodeBlock from '../components/CodeBlock';
import Terminal from '../components/Terminal';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';

interface FeatureItem {
  title: string;
  imageUrl?: string;
  description: ReactNode;
}

const features: FeatureItem[] = [
  {
    title: 'Define Your Test',
    description: (
      <>
        Define custom E2E test scenarios on target browser interaction:
        <CodeBlock
          language="typescript"
          code={`// test.js
function url() {
  return 'https://www.google.com/maps/';
}
async function action(page) {
  await page.click('button[aria-label="Hotels"]');
}
async function back(page) {
  await page.click('[aria-label="Clear search"]');
}

module.exports = {action, back, url};`}
        />
      </>
    ),
  },
  {
    title: 'Run memlab in CLI',
    description: (
      <>
        Find memory leaks with the custom E2E test scenario:
        <Terminal language="bash" code={`$ memlab run --scenario test.js`} />
        Support memory analyses for the previous browser test:
        <Terminal
          language="bash"
          code={`# Analyze duplicated string in heap
$ memlab analyze string
# Check unbound object growth
$ memlab analyze unbound-object
# Get shapes with unbound growth
$ memlab analyze unbound-shape
# discover more memory analyses
$ memlab analyze -h`}
        />
      </>
    ),
  },
  {
    title: 'Programming API',
    description: (
      <>
        Support different memory analyses for the previous browser test:
        <CodeBlock
          language="typescript"
          code={`const {findLeaks, takeSnapshots} = require('@memlab/api');

async function test() {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({scenario});
  const leaks = findLeaks(result);
  // ...
}`}
        />
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
      description="memlab is an E2E testing, memory leak detection, and heap analysis framework for front-end JavaScript.">
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
