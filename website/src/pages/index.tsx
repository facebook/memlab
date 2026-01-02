/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import React, {ReactNode, useEffect, useRef, useState} from 'react';
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
import * as Three from 'three';
import NET from 'vanta/dist/vanta.net.min';
import useWindowSize from '../lib/useWindowSize';

import normalizeTypeSpeed from '../lib/TypeSpeedNormalization';
import homePageStdouts from '../data/HomePageMainTerminal';

interface FeatureItem {
  title: string;
  docUrl?: string;
  imageUrl?: string;
  description: ReactNode;
}

const features: FeatureItem[] = [
  {
    title: 'Define Your Test',
    docUrl: 'docs/api/core/src/interfaces/IScenario',
    description: (
      <>
        Define E2E test scenarios on browser interaction:
        <CodeBlock
          language="typescript"
          code={`// test.js
function url() {
  return 'https://www.google.com/maps/place/Silicon+Valley,+CA/';
}
async function action(page) {
  await page.click('text/Hotels');
}
async function back(page) {
  await page.click('[aria-label="Close"]');
}

module.exports = {action, back, url};`}
        />
      </>
    ),
  },
  {
    title: 'Run memlab in CLI',
    docUrl: 'docs/cli/CLI-commands',
    description: (
      <>
        Find memory leaks with the custom E2E test scenario:
        <TerminalStatic
          language="bash"
          code={`$ memlab run --scenario test.js`}
        />
        Support memory analyses for the previous browser test:
        <TerminalStatic
          language="bash"
          code={`# Analyze duplicated string in heap
$ memlab analyze string
# Check unbound object growth
$ memlab analyze unbound-object
# Get shapes with unbound growth
$ memlab analyze unbound-shape
# Discover more memory analyses
$ memlab analyze -h`}
        />
      </>
    ),
  },
  {
    title: 'Programming API',
    docUrl: 'docs/api/',
    description: (
      <>
        Memory analysis for JavaScript heap snapshots:
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

function Feature({imageUrl, title, description, docUrl}) {
  const imgUrl = useBaseUrl(imageUrl);
  return (
    <div className={clsx('col col--4', styles.feature)}>
      {imgUrl && (
        <div className="text--center">
          <img className={styles.featureImage} src={imgUrl} alt={title} />
        </div>
      )}
      {docUrl ? (
        <Link className={styles.titleLink} to={docUrl}>
          <h3>{title}</h3>
        </Link>
      ) : (
        <h3>{title}</h3>
      )}
      <p>{description}</p>
    </div>
  );
}

const stdouts = normalizeTypeSpeed(homePageStdouts);
const MIN_POINTS = 6;
const MAX_POINTS = 16;
const BROWSER_SUPPORTS_WIDE_LINE = browserSupportsWideLine();
const ANIMATION_MAX_DISTANCE = BROWSER_SUPPORTS_WIDE_LINE ? 26 : 30;

function browserSupportsWideLine() {
  try {
    // Create a canvas and get its WebGL rendering context
    const canvas = document.createElement('canvas');
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext);

    // Check if WebGL is supported
    if (!gl) {
      return false;
    }
    // Query the line width range
    const lineWidthRange = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
    return lineWidthRange[1] > 1;
  } catch {
    return false;
  }
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();
  const headerContainerID = 'css-animated-bg-container';
  const [vantaEffect, setVantaEffect] = useState(null);
  const headerRef = useRef(null);
  const {width} = useWindowSize();

  useEffect(() => {
    if (!vantaEffect && width > 800) {
      setVantaEffect(
        NET({
          el: headerRef.current,
          THREE: Three,
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 170.0,
          minWidth: 170.0,
          scale: 0.9,
          scaleMobile: 0.4,
          color: 0x739c2a,
          backgroundColor: 0xf0db4f,
          points: Math.min(
            Math.max(Math.floor((12.0 * width) / 1800), MIN_POINTS),
            MAX_POINTS,
          ),
          maxDistance: ANIMATION_MAX_DISTANCE,
          spacing: 22.0,
        }),
      );
    }
    return () => {
      if (vantaEffect != null) {
        vantaEffect.destroy();
      }
    };
  }, [vantaEffect]);

  return (
    <Layout description="memlab is an E2E testing, memory leak detection, and heap analysis framework for front-end JavaScript.">
      <header
        id={headerContainerID}
        ref={headerRef}
        className={clsx('hero hero--primary', styles.heroBanner)}>
        <div id="header-container" className="container">
          <div id="left-header-section" className="container-section">
            <h1 id="title" className="hero__title">
              {siteConfig.title}
            </h1>
            <p id="sub-title" className="hero__subtitle">
              {siteConfig.tagline}
            </p>
            <div className={styles.buttons}>
              <Link
                id="learn-more"
                className={clsx(
                  'button button--outline button--secondary button--lg',
                  styles.getStarted,
                )}
                to={useBaseUrl('docs/getting-started')}>
                Learn more
              </Link>
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
                {features.map(({title, docUrl, imageUrl, description}) => (
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
}
