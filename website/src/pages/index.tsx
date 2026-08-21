/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import React, {
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
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

const INSTALL_COMMAND = 'npm install -g memlab';
const GITHUB_URL = 'https://github.com/facebook/memlab';
const NPM_URL = 'https://www.npmjs.com/package/memlab';

// the animated terminal is rendered at a fixed 780px width, so it is only
// mounted on the wide two-column layout that has room for it
const TERMINAL_REPLAY_MIN_WIDTH = 1400;
const VANTA_MIN_WIDTH = 997;

const stdouts = normalizeTypeSpeed(homePageStdouts);
const MIN_POINTS = 6;
const MAX_POINTS = 16;

// shown instead of the animated terminal on viewports that cannot fit it
const SAMPLE_OUTPUT: Array<{text: string; tone?: string}> = [
  {text: '$ memlab run --scenario test.js', tone: 'outCommand'},
  {text: ''},
  {text: 'MemLab found 46 leak(s)', tone: 'outSuccess'},
  {text: '--Similar leaks in this run: 4--', tone: 'outDim'},
  {text: '--Retained size of leaked objects: 8.3MB--', tone: 'outDim'},
  {text: '[Window](native) @35847 [8.3MB]'},
  {text: '  --20 (element)--->  [InternalNode](native) @130981728'},
  {text: '  --1 (element)--->  [EventListener](native) @131009888'},
  {text: '  --context (internal)--->  [<function scope>](object) @181905'},
  {text: '  --bigArray (variable)--->  [Array](object) @182925 [8.3MB]'},
];

interface FeatureItem {
  title: string;
  icon: ReactNode;
  docUrl?: string;
  description: ReactNode;
}

interface StepItem {
  title: string;
  docUrl?: string;
  description: string;
  body: ReactNode;
}

function Icon({children}: {children: ReactNode}): React.ReactElement {
  return (
    <svg
      aria-hidden={true}
      className={styles.featureIcon}
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="24">
      {children}
    </svg>
  );
}

const features: FeatureItem[] = [
  {
    title: 'Browser leak detection',
    docUrl: 'docs/getting-started',
    icon: (
      <Icon>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </Icon>
    ),
    description: (
      <>
        Drive your app with the Puppeteer API. memlab diffs the heap snapshots,
        filters out the noise, and clusters what actually leaked.
      </>
    ),
  },
  {
    title: 'Heap traversal API',
    docUrl: 'docs/api/',
    icon: (
      <Icon>
        <circle cx="5" cy="6" r="2.2" />
        <circle cx="19" cy="6" r="2.2" />
        <circle cx="12" cy="18" r="2.2" />
        <path d="M6.8 7.4 10.6 16M17.2 7.4 13.4 16M7.2 6h9.6" />
      </Icon>
    ),
    description: (
      <>
        An object-oriented API over snapshots from Chromium, Node.js,
        Electron.js, and Hermes — build your own leak detectors.
      </>
    ),
  },
  {
    title: 'Memory CLI toolbox',
    docUrl: 'docs/cli/CLI-commands',
    icon: (
      <Icon>
        <rect height="15" rx="2" width="18" x="3" y="4.5" />
        <path d="m7.5 10 2.5 2-2.5 2M13 14h3.5" />
      </Icon>
    ),
    description: (
      <>
        Built-in analyses for duplicate strings, oversized objects, and unbound
        growth — optimization wins beyond leaks.
      </>
    ),
  },
  {
    title: 'MemLens debugging',
    docUrl: 'docs/guides/visually-debug-memory-leaks-with-memlens',
    icon: (
      <Icon>
        <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.6" />
      </Icon>
    ),
    description: (
      <>
        Visualize leaks and debug them interactively in the browser, without
        leaving the page you are testing.
      </>
    ),
  },
  {
    title: 'Assertions in Node.js',
    docUrl: 'docs/api/core/src/interfaces/IHeapSnapshot',
    icon: (
      <Icon>
        <path d="M12 3.5 20 7v6c0 4-3.4 6.7-8 7.5-4.6-.8-8-3.5-8-7.5V7Z" />
        <path d="m9 12 2.2 2.2L15.5 10" />
      </Icon>
    ),
    description: (
      <>
        Let unit tests snapshot their own heap and assert that objects are gone
        — catch regressions in CI, not in production.
      </>
    ),
  },
  {
    title: 'MCP server for AI agents',
    docUrl: 'docs/mcp-server',
    icon: (
      <Icon>
        <rect height="11" rx="2.5" width="16" x="4" y="8" />
        <path d="M12 8V4.5M9 13.5h.01M15 13.5h.01M9.5 17h5" />
      </Icon>
    ),
    description: (
      <>
        Hand heap snapshots to Claude Code, Cursor, or any MCP client and
        investigate memory in plain English.
      </>
    ),
  },
];

const steps: StepItem[] = [
  {
    title: 'Define your test',
    docUrl: 'docs/api/core/src/interfaces/IScenario',
    description: 'Describe the interaction you want to check for leaks.',
    body: (
      <CodeBlock
        language="typescript"
        code={`// test.js
function url() {
  return 'https://www.google.com/maps';
}
async function action(page) {
  await page.click('text/Hotels');
}
async function back(page) {
  await page.click('[aria-label="Close"]');
}

module.exports = {action, back, url};`}
      />
    ),
  },
  {
    title: 'Run memlab in the CLI',
    docUrl: 'docs/cli/CLI-commands',
    description: 'One command drives the browser and reports leak traces.',
    body: (
      <>
        <TerminalStatic
          language="bash"
          code={`$ memlab run --scenario test.js`}
        />
        <TerminalStatic
          language="bash"
          code={`# Analyze duplicated strings in the heap
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
    title: 'Or use the API',
    docUrl: 'docs/api/',
    description: 'Take snapshots and find leaks programmatically.',
    body: (
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
    ),
  },
];

function Feature({description, docUrl, icon, title}: FeatureItem) {
  const url = useBaseUrl(docUrl);
  const content = (
    <>
      <span className={styles.featureIconWrapper}>{icon}</span>
      <h3 className={styles.featureTitle}>{title}</h3>
      <p className={styles.featureText}>{description}</p>
    </>
  );
  return docUrl != null ? (
    <Link className={clsx(styles.featureCard, styles.featureLink)} to={url}>
      {content}
    </Link>
  ) : (
    <div className={styles.featureCard}>{content}</div>
  );
}

function Step({body, description, docUrl, index, title}) {
  const url = useBaseUrl(docUrl);
  return (
    <div className={styles.stepCard}>
      <div className={styles.stepHeader}>
        <span className={styles.stepNumber}>{index}</span>
        <div>
          <h3 className={styles.stepTitle}>
            {docUrl != null ? <Link to={url}>{title}</Link> : title}
          </h3>
          <p className={styles.stepText}>{description}</p>
        </div>
      </div>
      <div className={styles.stepBody}>{body}</div>
    </div>
  );
}

function CopyableCommand({
  className,
  command,
}: {
  className?: string;
  command: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const onCopy = useCallback(() => {
    const onDone = () => {
      setCopied(true);
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    };
    // the clipboard is unavailable in insecure contexts; the command stays
    // selectable so it can still be copied by hand
    const onFail = () => setCopied(false);
    try {
      navigator.clipboard.writeText(command).then(onDone, onFail);
    } catch {
      onFail();
    }
  }, [command]);

  return (
    <div className={clsx(styles.install, className)}>
      <code className={styles.installCommand}>
        <span className={styles.installPrompt}>$</span> {command}
      </code>
      <button
        aria-label={copied ? 'Copied' : 'Copy install command'}
        className={styles.copyButton}
        onClick={onCopy}
        type="button">
        {copied ? (
          <svg
            aria-hidden={true}
            fill="none"
            height="16"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="16">
            <path d="m5 12.5 4.5 4.5L19 7" />
          </svg>
        ) : (
          <svg
            aria-hidden={true}
            fill="none"
            height="16"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="16">
            <rect height="13" rx="2" width="11" x="9" y="8" />
            <path d="M5.5 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v.5" />
          </svg>
        )}
        <span className={styles.copyLabel}>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

function GitHubIcon(): React.ReactElement {
  return (
    <svg
      aria-hidden={true}
      fill="currentColor"
      height="18"
      viewBox="0 0 24 24"
      width="18">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.55v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.71.08-.7.08-.7 1.16.09 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.24 2.76.12 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.42.36.78 1.06.78 2.14v3.17c0 .3.21.66.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export default function Home(): React.ReactElement {
  const {siteConfig} = useDocusaurusContext();
  const heroRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const {width} = useWindowSize();
  const showAnimation = mounted && width >= VANTA_MIN_WIDTH;
  const showTerminalReplay = mounted && width >= TERMINAL_REPLAY_MIN_WIDTH;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!showAnimation) {
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const effect = NET({
      el: heroRef.current,
      THREE: Three,
      mouseControls: true,
      touchControls: false,
      gyroControls: false,
      minHeight: 170.0,
      minWidth: 170.0,
      scale: 0.9,
      scaleMobile: 0.4,
      color: 0xf0db4f,
      backgroundColor: 0x0a0c11,
      // read the width here rather than from the render scope so that a resize
      // does not tear down and rebuild the WebGL scene on every frame
      points: Math.min(
        Math.max(Math.floor((12.0 * window.innerWidth) / 1800), MIN_POINTS),
        MAX_POINTS,
      ),
      maxDistance: 26,
      spacing: 22.0,
    });
    return () => effect.destroy();
  }, [showAnimation]);

  return (
    <Layout description="memlab is an E2E testing, memory leak detection, and heap analysis framework for front-end JavaScript.">
      <header className={styles.hero} ref={heroRef}>
        <div className={styles.heroOverlay} />
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <a
              className={styles.heroBadge}
              href="https://engineering.fb.com/2022/09/12/open-source/memlab/"
              rel="noreferrer noopener"
              target="_blank">
              <span className={styles.heroBadgeDot} />
              Built and battle-tested at Meta
              <span className={styles.heroBadgeArrow}>→</span>
            </a>
            <h1 className={styles.heroTitle}>
              Find <span className={styles.gradientText}>memory leaks</span> in
              JavaScript
            </h1>
            <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
            <div className={styles.heroActions}>
              <Link
                className={styles.buttonPrimary}
                to={useBaseUrl('docs/getting-started')}>
                Get started
              </Link>
              <a
                className={styles.buttonGhost}
                href={GITHUB_URL}
                rel="noreferrer noopener"
                target="_blank">
                <GitHubIcon />
                Star on GitHub
              </a>
            </div>
            <CopyableCommand command={INSTALL_COMMAND} />
          </div>

          <div className={styles.heroVisual}>
            <div className={styles.terminalCard}>
              <div className={styles.terminalBar}>
                <span className={clsx(styles.terminalDot, styles.dotRed)} />
                <span className={clsx(styles.terminalDot, styles.dotYellow)} />
                <span className={clsx(styles.terminalDot, styles.dotGreen)} />
                <span className={styles.terminalTitle}>memlab run</span>
              </div>
              <div className={styles.terminalBody}>
                {showTerminalReplay ? (
                  <TerminalReplay stdouts={stdouts} />
                ) : (
                  <pre className={styles.terminalStaticOutput}>
                    {SAMPLE_OUTPUT.map((line, i) => (
                      <div
                        className={line.tone != null ? styles[line.tone] : null}
                        key={i}>
                        {line.text === '' ? ' ' : line.text}
                      </div>
                    ))}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <Showcase />

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>Features</p>
            <h2 className={styles.sectionTitle}>
              Everything you need to chase down memory
            </h2>
            <p className={styles.sectionSubtitle}>
              From automated end-to-end leak detection to low-level heap
              analysis — in the browser, in Node.js, and in CI.
            </p>
          </div>
          <div className={styles.featureGrid}>
            {features.map((feature) => (
              <Feature key={feature.title} {...feature} />
            ))}
          </div>
        </section>

        <section className={clsx(styles.section, styles.sectionAlt)}>
          <div className={styles.sectionHead}>
            <p className={styles.eyebrow}>How it works</p>
            <h2 className={styles.sectionTitle}>Three steps to a leak trace</h2>
            <p className={styles.sectionSubtitle}>
              Write a scenario, run it, and read the reference chain that keeps
              your objects alive.
            </p>
          </div>
          <div className={styles.stepGrid}>
            {steps.map((step, i) => (
              <Step key={step.title} index={i + 1} {...step} />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.split}>
            <div className={styles.splitCopy}>
              <p className={styles.eyebrow}>Retainer traces</p>
              <h2 className={styles.sectionTitle}>
                See exactly what is holding memory
              </h2>
              <p className={styles.sectionSubtitle}>
                memlab walks the reference chain from the GC root down to the
                leaked object, so you know which reference to break instead of
                guessing. Similar leaks are clustered, so 46 leaked objects
                become a handful of real bugs to fix.
              </p>
              <Link
                className={styles.textLink}
                to={useBaseUrl('docs/guides/guides-find-leaks')}>
                Read the debugging guide →
              </Link>
            </div>
            <div className={styles.splitMedia}>
              <img
                alt="memlab comparing heap snapshots to surface a leak trace"
                className={styles.splitImage}
                height={982}
                loading="lazy"
                src={useBaseUrl('img/heap-diff.gif')}
                width={2030}
              />
            </div>
          </div>
        </section>

        <section className={styles.ctaSection}>
          <div className={styles.cta}>
            <h2 className={styles.ctaTitle}>Start finding leaks in minutes</h2>
            <p className={styles.ctaText}>
              Install the CLI, point it at a page, and let memlab do the
              snapshot diffing for you.
            </p>
            <CopyableCommand
              className={styles.ctaInstall}
              command={INSTALL_COMMAND}
            />
            <div className={styles.ctaLinks}>
              <Link
                className={styles.buttonPrimary}
                to={useBaseUrl('docs/intro')}>
                Read the docs
              </Link>
              <a
                className={styles.buttonGhost}
                href={NPM_URL}
                rel="noreferrer noopener"
                target="_blank">
                View on npm
              </a>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
