/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {IHeapNode} from '@memlab/core';
import {z} from 'zod';
import {getSnapshot} from '../heap-state.js';
import {
  errorResult,
  formatBytes,
  formatNumber,
  markdownTable,
  toolResult,
} from '../utils.js';

/**
 * Is this node an ATTACHED DOM element?
 *
 * Verified against a live page rather than assumed: on a real capture this
 * matcher counted **364** elements where `document.querySelectorAll('*').length`
 * on the same page at the same moment returned **363**, with per-tag counts
 * matching exactly (link 108/108, script 92/92, span 14/14, meta 12/12, style
 * 4/4, li 3/3).
 *
 * The `SVG*Element` / `HTML*Element` arm is not redundant. Most elements are
 * named `<tag attr="...">`, but SVG elements are named by their IDL interface
 * (`SVGPathElement`, `SVGTitleElement`) with no angle bracket — 29 of that 364.
 * Matching only `<` undercounts every icon-heavy surface.
 */
export function isAttachedElement(node: IHeapNode): boolean {
  if (node.type !== 'native') return false;
  const n = node.name;
  if (n.startsWith('Detached ')) return false;
  return n.startsWith('<') || /^(?:SVG|HTML)\w*Element$/.test(n);
}

export interface ElementFacts {
  tag: string;
  /** Owning component, from the StyleX debug class `Foo__styles.bar`. */
  component: string | null;
  testid: string | null;
  /** Grouping key for "the same bit of markup, repeated". */
  signature: string;
}

const STYLEX_DEBUG_CLASS = /([A-Za-z0-9_$]+)__styles\.[A-Za-z0-9_$]+/;

/**
 * Tags that occupy no layout box.
 *
 * They still count toward `dom_element_count` so they stay in the tag census,
 * but they can never be virtualized, and they are numerous: on a real capture
 * `<link>` (108) and `<script>` (92) outranked every application component and
 * took the top two virtualization rows, each promising a saving that cannot
 * exist.
 */
const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'link',
  'meta',
  'style',
  'title',
  'head',
  'base',
  'noscript',
  'template',
]);

export function describeElement(name: string): ElementFacts {
  const tagMatch = name.match(/^<([A-Za-z0-9-]+)/);
  const idlMatch = name.match(/^(?:SVG|HTML)(\w*)Element$/);
  const tag = tagMatch
    ? tagMatch[1].toLowerCase()
    : idlMatch
      ? `svg:${(idlMatch[1] || 'svg').toLowerCase()}`
      : '?';

  const classMatch = name.match(/class="([^"]*)"/);
  const classes = classMatch?.[1] ?? '';
  const component = classes.match(STYLEX_DEBUG_CLASS)?.[1] ?? null;
  const testid = name.match(/data-testid="([^"]*)"/)?.[1] ?? null;

  // Signature groups "the same markup repeated". A testid is the most specific
  // stable identity; the StyleX debug class is next; the raw class list is the
  // fallback and is stable across identical rows because StyleX atomic classes
  // are deterministic for the same style set.
  const signature =
    testid != null
      ? `${tag}[${testid}]`
      : component != null
        ? `${tag}.${component}`
        : classes !== ''
          ? `${tag}.${classes.split(/\s+/).slice(0, 6).join(' ')}`
          : tag;

  return {tag, component, testid, signature};
}

interface Bucket {
  count: number;
  selfSize: number;
  example: string;
}

function bump(
  map: Map<string, Bucket>,
  key: string,
  selfSize: number,
  example: string,
): void {
  const b = map.get(key);
  if (b) {
    b.count++;
    b.selfSize += selfSize;
  } else {
    map.set(key, {count: 1, selfSize, example});
  }
}

const topN = (m: Map<string, Bucket>, n: number): Array<[string, Bucket]> =>
  [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, n);

export function registerDomAudit(server: McpServer): void {
  server.tool(
    'memlab_dom_audit',
    'Budget the ATTACHED DOM and rank the surfaces worth virtualizing. This is an OPTIMIZATION tool, not a leak tool — the elements it reports are all live and correctly retained; the point is that there are too many of them.\n\n' +
      'Element count drives style recalculation, layout, and per-element Blink side-data (`ComputedStyle`, `UniqueElementData`, `NodeRareData`) independently of any leak, so a surface rendering 400 rows when 15 are on screen pays for all 400 on every recalc. That cost never shows up in a leak report, because nothing is leaking.\n\n' +
      'Reports the total attached element count, the per-tag split, and — the actionable part — a per-COMPONENT census recovered from StyleX debug class names (`WAWebChatCell__styles.cell` names the module) and `data-testid`. A component with a high instance count and a fixed per-instance element cost is a list, and a list is what virtualization is for.\n\n' +
      'What this can and cannot see: the element count is exact (validated against `document.querySelectorAll("*").length` on a live page — 364 vs 363, per-tag counts matching). CONTAINMENT is not available: a heap snapshot exposes parent, child, sibling and document links all as the same edge type, so "which container holds these rows" cannot be reconstructed from a capture — measured 1,286 element-to-element edges across 364 elements, most with 3-4 apparent parents. Nor is viewport visibility. For those, drive the live page instead.',
    {
      min_instances: z
        .number()
        .int()
        .min(2)
        .optional()
        .default(20)
        .describe(
          'A component/signature needs at least this many instances to be reported as a virtualization candidate. Below ~20 the win rarely pays for the complexity.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(20)
        .describe('Rows per table.'),
      visible_estimate: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(15)
        .describe(
          'How many instances a viewport plausibly shows at once, used ONLY to size the arithmetic in the savings column. A snapshot carries no viewport or scroll state, so this is your estimate, not a measurement.',
        ),
    },
    async ({min_instances, limit, visible_estimate}) => {
      try {
        const snapshot = getSnapshot();

        const byTag = new Map<string, Bucket>();
        const byComponent = new Map<string, Bucket>();
        const bySignature = new Map<string, Bucket>();
        let attached = 0;
        let detachedElements = 0;
        let attachedSelfSize = 0;
        let unattributed = 0;
        // Per-element Blink side-data: allocated per element, so it scales with
        // element count and is the memory half of the same story.
        let sideData = 0;
        let sideDataSize = 0;

        snapshot.nodes.forEach((node: IHeapNode) => {
          if (node.type !== 'native') return;
          const name = node.name;
          if (
            name.startsWith('blink::UniqueElementData') ||
            name.startsWith('blink::ShareableElementData') ||
            name.startsWith('blink::NodeRareData') ||
            name.startsWith('blink::ComputedStyle') ||
            name.startsWith('ElementIntersectionObserverData')
          ) {
            sideData++;
            sideDataSize += node.self_size;
            return;
          }
          if (name.startsWith('Detached ')) {
            if (/^Detached (?:<|SVG\w*Element|HTML\w*Element)/.test(name)) {
              detachedElements++;
            }
            return;
          }
          if (!isAttachedElement(node)) return;

          attached++;
          attachedSelfSize += node.self_size;
          const f = describeElement(name);
          bump(byTag, f.tag, node.self_size, name);
          bump(bySignature, f.signature, node.self_size, name);
          if (f.component != null) {
            bump(byComponent, f.component, node.self_size, name);
          } else {
            unattributed++;
          }
        });

        if (attached === 0) {
          return toolResult(
            'No attached DOM elements found. This is either a Node.js snapshot, or the capture ' +
              'predates the page building its UI. `memlab_snapshot_summary` will say which.',
          );
        }

        const lines: string[] = [
          '## DOM audit — attached element budget',
          '',
          `**${formatNumber(attached)} attached elements**, ${formatBytes(attachedSelfSize)} of element self-size, ` +
            `plus ${formatNumber(sideData)} per-element Blink side-data objects (${formatBytes(sideDataSize)}: ComputedStyle, UniqueElementData, NodeRareData, …).`,
          '',
          `_${formatNumber(detachedElements)} DETACHED elements are excluded — those are a leak question, not a payload question; use \`memlab_detached_dom\`._`,
          '',
          '### By tag',
          '',
          markdownTable(
            ['Tag', 'Count', 'Self size'],
            topN(byTag, limit).map(([k, b]) => [
              k,
              formatNumber(b.count),
              formatBytes(b.selfSize),
            ]),
            new Set([1, 2]),
          ),
          '',
        ];

        // ---- virtualization candidates ------------------------------------
        const candidates = topN(bySignature, 1000).filter(
          ([k, b]) =>
            b.count >= min_instances &&
            !NON_RENDERED_TAGS.has(k.split(/[.[]/)[0]),
        );
        lines.push('### Virtualization candidates — repeated markup', '');
        if (candidates.length === 0) {
          lines.push(
            `No repeated element signature reaches ${formatNumber(min_instances)} instances, so there is no ` +
              'windowing win to be had on this capture. Either the page is not rendering a long list, or it ' +
              'is already virtualized.',
            '',
          );
        } else {
          lines.push(
            markdownTable(
              [
                'Signature (repeated element)',
                'Instances',
                'Self size',
                `Beyond ${formatNumber(visible_estimate)} on screen`,
              ],
              candidates
                .slice(0, limit)
                .map(([k, b]) => [
                  k.length > 56 ? `${k.slice(0, 53)}…` : k,
                  formatNumber(b.count),
                  formatBytes(b.selfSize),
                  b.count > visible_estimate
                    ? formatNumber(b.count - visible_estimate)
                    : '—',
                ]),
              new Set([1, 2, 3]),
            ),
            '',
            '_Each row is ONE element repeated N times, NOT a whole item of markup: a list item built from 12 ' +
              'nested elements appears as 12 separate signatures sharing an instance count, and a repeated LEAF ' +
              '(an `svg:path` icon) is the contents of a repeated item rather than a candidate in its own right. ' +
              'The last column is therefore an upper bound on that one element type, not a saving you can bank — ' +
              'the unit you actually wrap is the repeated container, and finding it needs the live page._',
            '',
          );
        }

        // ---- component attribution ----------------------------------------
        lines.push('### By component (from StyleX debug class names)', '');
        if (byComponent.size === 0) {
          lines.push(
            'No StyleX debug class names in this capture, so per-component attribution is unavailable. ' +
              'Debug class names are a DEV-build feature (`Foo__styles.bar`); a production bundle emits only ' +
              'atomic classes, and this table will be empty against one.',
            '',
          );
        } else {
          const rows = topN(byComponent, limit).map(([k, b]) => [
            k.length > 44 ? `${k.slice(0, 41)}…` : k,
            formatNumber(b.count),
            formatBytes(b.selfSize),
            `${((b.count / attached) * 100).toFixed(1)}%`,
          ]);
          lines.push(
            markdownTable(
              ['Component', 'Elements', 'Self size', 'Share of DOM'],
              rows,
              new Set([1, 2, 3]),
            ),
            '',
            `_${formatNumber(unattributed)} of ${formatNumber(attached)} elements carry no StyleX debug class ` +
              '(host chrome, `<script>`/`<link>`/`<meta>`, third-party markup) and are not attributed above._',
            '',
          );
        }

        lines.push(
          '---',
          '',
          '**How to read this.** A component with many elements AND many instances of one signature is a list: ' +
            'windowing it removes `(instances − visible) × elements-per-instance` elements from style recalc and ' +
            'layout, and the same multiple of per-element side-data from the heap. A component with many elements ' +
            'and FEW instances is deep markup instead — the win there is collapsing wrapper elements, not virtualizing.',
          '',
          '**What this cannot tell you, and where to get it.** A snapshot has no viewport, no scroll offset and no ' +
            'usable containment (parent, child and sibling links are indistinguishable in the capture), so it cannot ' +
            'say what fraction of these instances is off-screen — which is the number that decides whether ' +
            'virtualizing is worth it. Measure that on the live page.',
        );

        return toolResult(lines.join('\n'));
      } catch (e) {
        return errorResult(e instanceof Error ? e : new Error(String(e)));
      }
    },
  );
}
