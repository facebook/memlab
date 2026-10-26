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
import '@fontsource-variable/geist';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import CodeBlock from '../components/CodeBlock';
import TerminalStatic from '../components/TerminalStatic';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './styles.module.css';
import TerminalReplay from '../components/TerminalReplay';
import Showcase from '../components/Showcase';
import useWindowSize from '../lib/useWindowSize';

import normalizeTypeSpeed from '../lib/TypeSpeedNormalization';
import homePageStdouts from '../data/HomePageMainTerminal';

const INSTALL_COMMAND = 'npm install -g memlab';
const GITHUB_URL = 'https://github.com/facebook/memlab';
const NPM_URL = 'https://www.npmjs.com/package/memlab';

// the animated terminal is rendered at a fixed 780px width, so it is only
// mounted when the viewport has room for it
const TERMINAL_REPLAY_MIN_WIDTH = 900;

const stdouts = normalizeTypeSpeed(homePageStdouts);

type Tone = 'outCommand' | 'outSuccess' | 'outDim' | 'outLeak';

// shown instead of the animated terminal on viewports that cannot fit it
const SAMPLE_OUTPUT: Array<{text: string; tone?: Tone}> = [
  {text: '$ memlab run --scenario test.js', tone: 'outCommand'},
  {text: ''},
  {text: 'MemLab found 46 leak(s)', tone: 'outSuccess'},
  {text: '--Similar leaks in this run: 4--', tone: 'outDim'},
  {text: '--Retained size of leaked objects: 8.3MB--', tone: 'outDim'},
  {text: '[Window](native) @35847 [8.3MB]'},
  {text: '  --20 (element)--->  [InternalNode](native) @130981728'},
  {text: '  --1 (element)--->  [EventListener](native) @131009888'},
  {text: '  --context (internal)--->  [<function scope>](object) @181905'},
  {
    text: '  --bigArray (variable)--->  [Array](object) @182925 [8.3MB]',
    tone: 'outLeak',
  },
];

// one leak story shared by the trace card and the MCP session: a dialog
// subscribes to an app-wide event bus on mount and never unsubscribes
const TRACE_NODES: Array<{
  edge?: string;
  node: string;
  kind: string;
  size?: string;
}> = [
  {node: 'Window', kind: 'GC root'},
  {edge: 'eventBus', node: 'EventBus', kind: 'object'},
  {edge: 'listeners', node: 'Array', kind: 'object'},
  {edge: '[0]', node: 'handleThemeChange()', kind: 'closure'},
  {edge: 'dialog', node: 'SettingsDialog', kind: 'captured variable'},
  {
    edge: 'container',
    node: 'Detached <div class="settings">',
    kind: '1,205 detached nodes',
    size: '7.4MB',
  },
];

interface FeatureItem {
  title: string;
  icon: ReactNode;
  docUrl: string;
  description: ReactNode;
  badge?: string;
  visual?: ReactNode;
  wide?: boolean;
}

interface StepItem {
  title: string;
  docUrl: string;
  description: string;
  file: string;
  body: ReactNode;
}

function Icon({children}: {children: ReactNode}): React.ReactElement {
  return (
    <svg
      aria-hidden={true}
      className={styles.featureIcon}
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="20">
      {children}
    </svg>
  );
}

function TraceVisual(): React.ReactElement {
  return (
    <div className={styles.trace}>
      <div className={styles.traceHeader}>
        <span className={styles.traceCommand}>
          $ memlab run --scenario settings.js
        </span>
        <span className={styles.traceRetained}>1 leak · 7.4MB</span>
      </div>
      <ol aria-label="Example retainer trace" className={styles.traceList}>
        {TRACE_NODES.map(({edge, kind, node, size}, i) => (
          <li
            className={clsx(
              styles.traceRow,
              i === TRACE_NODES.length - 1 && styles.traceLeak,
            )}
            key={node}>
            <span className={styles.traceDot} />
            {edge != null && <span className={styles.traceEdge}>.{edge}</span>}
            <span className={styles.traceNode}>{node}</span>
            <span className={styles.traceKind}>{kind}</span>
            {size != null && <span className={styles.traceSize}>{size}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ToolCall({
  args,
  children,
  name,
}: {
  args?: string;
  children: ReactNode;
  name: string;
}): React.ReactElement {
  return (
    <div className={styles.agentBlock}>
      <div>
        <span className={styles.agentBullet}>●</span>
        <span className={styles.agentTool}>{name}</span>
        <span className={styles.agentArgs}>({args ?? ''})</span>
      </div>
      <div className={styles.agentResult}>{children}</div>
    </div>
  );
}

function AgentVisual(): React.ReactElement {
  return (
    <WindowFrame className={styles.agentWindow} title="agent · memlab mcp">
      <div aria-hidden={true} className={styles.agent}>
        <p className={styles.agentPrompt}>
          The heap grows every time I open and close Settings. The snapshots are
          in ./snaps. What is leaking?
        </p>
        <ToolCall args="./snaps/*.heapsnapshot" name="memlab_load_snapshot">
          6 snapshots: a baseline + 5 open/close cycles
        </ToolCall>
        <ToolCall name="memlab_leak_report">
          <div>Grows on 5 of 5 cycles:</div>
          <div className={styles.agentRow}>
            <span>SettingsDialog</span>
            <span className={styles.agentBad}>+1 / cycle</span>
          </div>
          <div className={styles.agentRow}>
            <span>Detached HTMLDivElement</span>
            <span className={styles.agentBad}>+241 / cycle</span>
          </div>
          <div className={styles.agentRow}>
            <span>Retained</span>
            <span className={styles.agentBad}>+7.4MB / cycle</span>
          </div>
        </ToolCall>
        <ToolCall name="memlab_settle_check">
          None of it comes back after idle + GC: a leak, not work in flight.
        </ToolCall>
        <ToolCall name="memlab_dev_artifacts">
          0 B retained only by DevTools or extensions.
        </ToolCall>
        <ToolCall args="SettingsDialog" name="memlab_retainer_trace">
          <div>window</div>
          <div className={styles.agentRow}>
            <span>&nbsp;&nbsp;.eventBus.listeners[0]</span>
            <span>handleThemeChange()</span>
          </div>
          <div className={styles.agentRow}>
            <span>&nbsp;&nbsp;&nbsp;&nbsp;.dialog</span>
            <span>SettingsDialog</span>
          </div>
          <div className={styles.agentRow}>
            <span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.container</span>
            <span className={styles.agentBad}>Detached &lt;div&gt; 7.4MB</span>
          </div>
        </ToolCall>
        <p className={styles.agentSay}>
          <code>SettingsDialog</code> subscribes <code>handleThemeChange</code>{' '}
          to <code>eventBus</code> on mount and never unsubscribes. The listener
          closure keeps every closed dialog reachable from <code>window</code>.
          Return the unsubscribe from the effect:
        </p>
        <pre className={styles.agentCode}>
          {`useEffect(
  () => eventBus.on('theme', handleThemeChange),
  [],
);`}
        </pre>
        <p className={styles.agentPrompt}>
          Fixed. New snapshots are in ./snaps-fixed.
        </p>
        <ToolCall args="./snaps → ./snaps-fixed" name="memlab_verify_fix">
          <div className={styles.agentRow}>
            <span>Growth / cycle</span>
            <span className={styles.agentGood}>7.4MB → 0 B</span>
          </div>
          <div className={styles.agentRow}>
            <span>Detached nodes</span>
            <span className={styles.agentGood}>1,205 → 0</span>
          </div>
          <div className={styles.agentGood}>✓ Leak fixed</div>
        </ToolCall>
      </div>
    </WindowFrame>
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
        filters out the noise, and hands you the retainer trace of what actually
        leaked.
      </>
    ),
    visual: <TraceVisual />,
  },
  {
    title: 'MCP server for AI agents',
    docUrl: 'docs/mcp-server',
    badge: 'New',
    wide: true,
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
    visual: <AgentVisual />,
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
];

const steps: StepItem[] = [
  {
    title: 'Define your test',
    docUrl: 'docs/api/core/src/interfaces/IScenario',
    description: 'Describe the interaction you want to check for leaks.',
    file: 'test.js',
    body: (
      <CodeBlock
        language="typescript"
        code={`function url() {
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
    file: 'zsh',
    body: (
      <TerminalStatic
        language="bash"
        code={`$ memlab run --scenario test.js

# Analyze duplicated strings in the heap
$ memlab analyze string
# Check unbound object growth
$ memlab analyze unbound-object
# Get shapes with unbound growth
$ memlab analyze unbound-shape
# Discover more memory analyses
$ memlab analyze -h`}
      />
    ),
  },
  {
    title: 'Or use the API',
    docUrl: 'docs/api/',
    description: 'Take snapshots and find leaks programmatically.',
    file: 'find-leaks.js',
    body: (
      <CodeBlock
        language="typescript"
        code={`const {findLeaks, takeSnapshots} =
  require('@memlab/api');

async function test() {
  const scenario = {
    url: () => 'https://www.facebook.com',
  };
  const result = await takeSnapshots({
    scenario,
  });
  const leaks = findLeaks(result);
  // ...
}`}
      />
    ),
  },
];

function WindowFrame({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}): React.ReactElement {
  return (
    <div className={clsx(styles.window, className)}>
      <div className={styles.windowBar}>
        <span className={styles.windowDots} aria-hidden={true}>
          <span />
          <span />
          <span />
        </span>
        <span className={styles.windowTitle}>{title}</span>
      </div>
      <div className={styles.windowBody}>{children}</div>
    </div>
  );
}

// tracks the pointer so the card can paint a spotlight under it
function onSpotlightMove(event: React.MouseEvent<HTMLElement>) {
  const card = event.currentTarget;
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  card.style.setProperty('--my', `${event.clientY - rect.top}px`);
}

function Feature({
  badge,
  description,
  docUrl,
  icon,
  title,
  visual,
  wide,
}: FeatureItem) {
  return (
    <Link
      className={clsx(
        styles.featureCard,
        visual != null && styles.featureLarge,
        wide && styles.featureWide,
        badge != null && styles.featureHighlight,
      )}
      onMouseMove={onSpotlightMove}
      to={useBaseUrl(docUrl)}>
      <div className={styles.featureCopy}>
        <div className={styles.featureHead}>
          <span className={styles.featureIconWrapper}>{icon}</span>
          {badge != null && (
            <span className={styles.featureBadge}>{badge}</span>
          )}
        </div>
        <h3 className={styles.featureTitle}>{title}</h3>
        <p className={styles.featureText}>{description}</p>
      </div>
      {visual != null && <div className={styles.featureVisual}>{visual}</div>}
      <span aria-hidden={true} className={styles.featureArrow}>
        →
      </span>
    </Link>
  );
}

function Step({body, description, docUrl, file, index, title}) {
  return (
    <div className={styles.step}>
      <div className={styles.stepHeader}>
        <span className={styles.stepNumber}>{index}</span>
        <div>
          <h3 className={styles.stepTitle}>
            <Link to={useBaseUrl(docUrl)}>{title}</Link>
          </h3>
          <p className={styles.stepText}>{description}</p>
        </div>
      </div>
      <WindowFrame className={styles.stepWindow} title={file}>
        {body}
      </WindowFrame>
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
            height="15"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="15">
            <path d="m5 12.5 4.5 4.5L19 7" />
          </svg>
        ) : (
          <svg
            aria-hidden={true}
            fill="none"
            height="15"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
            width="15">
            <rect height="13" rx="2" width="11" x="9" y="8" />
            <path d="M5.5 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v.5" />
          </svg>
        )}
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

function SectionHead({
  eyebrow,
  subtitle,
  title,
}: {
  eyebrow: string;
  subtitle: ReactNode;
  title: ReactNode;
}): React.ReactElement {
  return (
    <div className={styles.sectionHead}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <p className={styles.sectionSubtitle}>{subtitle}</p>
    </div>
  );
}

export default function Home(): React.ReactElement {
  const [mounted, setMounted] = useState(false);
  const {width} = useWindowSize();
  const showTerminalReplay = mounted && width >= TERMINAL_REPLAY_MIN_WIDTH;

  useEffect(() => setMounted(true), []);

  return (
    <Layout description="memlab is an E2E testing, memory leak detection, and heap analysis framework for front-end JavaScript.">
      <div className={styles.page}>
        <header className={styles.hero}>
          <div aria-hidden={true} className={styles.heroAurora} />
          <div aria-hidden={true} className={styles.heroGrid} />
          <div className={styles.heroInner}>
            <Link
              className={styles.heroBadge}
              to={useBaseUrl('docs/mcp-server')}>
              <span className={styles.heroBadgeTag}>New</span>
              Investigate heaps with your AI agent
              <span className={styles.heroBadgeArrow}>→</span>
            </Link>
            <h1 className={styles.heroTitle}>
              Find <span className={styles.gradientText}>memory leaks</span>
              <br />
              in JavaScript
            </h1>
            <p className={styles.heroSubtitle}>
              memlab drives your app in a real browser, diffs the heap
              snapshots, and shows you the exact reference chain keeping leaked
              objects alive. Works with heaps from Chromium, Node.js, Electron,
              and Hermes.
            </p>
            <div className={styles.heroActions}>
              <Link
                className={styles.buttonPrimary}
                to={useBaseUrl('docs/getting-started')}>
                Get started
                <span aria-hidden={true} className={styles.buttonArrow}>
                  →
                </span>
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
            <div aria-hidden={true} className={styles.heroGlow} />
            <WindowFrame className={styles.terminalWindow} title="memlab run">
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
            </WindowFrame>
          </div>
        </header>

        <main className={styles.main}>
          <Showcase />

          <section className={styles.section}>
            <SectionHead
              eyebrow="Features"
              title={
                <>
                  Everything you need to{' '}
                  <span className={styles.gradientText}>chase down memory</span>
                </>
              }
              subtitle="From automated end-to-end leak detection to low-level heap analysis — in the browser, in Node.js, and in CI."
            />
            <div className={styles.bento}>
              {features.map((feature) => (
                <Feature key={feature.title} {...feature} />
              ))}
            </div>
          </section>

          <section className={styles.section}>
            <SectionHead
              eyebrow="How it works"
              title="Three steps to a leak trace"
              subtitle="Write a scenario, run it, and read the reference chain that keeps your objects alive."
            />
            <div className={styles.steps}>
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
                <ul className={styles.checklist}>
                  <li>Detached DOM and unmounted React fibers, flagged</li>
                  <li>Leaks clustered by retainer trace similarity</li>
                  <li>Retained sizes, so you fix the biggest first</li>
                </ul>
                <Link
                  className={styles.textLink}
                  to={useBaseUrl('docs/guides/guides-find-leaks')}>
                  Read the debugging guide →
                </Link>
              </div>
              <div className={styles.splitMedia}>
                <div aria-hidden={true} className={styles.splitGlow} />
                <WindowFrame title="memlab — heap diff">
                  <img
                    alt="memlab comparing heap snapshots to surface a leak trace"
                    className={styles.splitImage}
                    height={982}
                    loading="lazy"
                    src={useBaseUrl('img/heap-diff.gif')}
                    width={2030}
                  />
                </WindowFrame>
              </div>
            </div>
          </section>

          <section className={styles.ctaSection}>
            <div className={styles.cta}>
              <div aria-hidden={true} className={styles.ctaGrid} />
              <h2 className={styles.ctaTitle}>
                Start finding leaks{' '}
                <span className={styles.gradientText}>in minutes</span>
              </h2>
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
                  <span aria-hidden={true} className={styles.buttonArrow}>
                    →
                  </span>
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
      </div>
    </Layout>
  );
}
