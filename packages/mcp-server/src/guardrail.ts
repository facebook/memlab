/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

import crypto from 'crypto';
import {isTerse, shouldEmitNote} from './heap-state.js';
import {makeProgressReporter, runWithProgress} from './progress.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  beginAnalysisBudget,
  endAnalysisBudget,
  getAnalysisTimeoutMs,
  activeElapsedMs,
  ScanTimeoutError,
} from './analysis-budget.js';
import {toolResult} from './utils.js';
import {getRegisteredTool, recordToolHandler} from './tool-registry.js';

type AnyFn = (...a: unknown[]) => unknown;

/**
 * Install a process-wide wall-clock guardrail around every tool call.
 *
 * Monkey-patches `server.tool` so each registered handler is wrapped: a budget
 * is armed for the call (per-call `timeout_ms` arg > MEMLAB_ANALYSIS_TIMEOUT_MS
 * env > 90s default), the heap-iteration funnels (see heap-state.ts) feed it,
 * and if the budget trips the handler's loop throws a {@link ScanTimeoutError}
 * which we convert into a clean "analysis stopped" result instead of letting a
 * runaway scan wedge / OOM the server.
 *
 * Must be called BEFORE the tools are registered so they register wrapped.
 */

/**
 * Parameters the caller passed that the tool does not declare.
 *
 * `timeout_ms` is universally accepted — the guardrail reads it off every call
 * whether or not a given tool declares it — so it is never reported.
 */
function unknownParamNames(
  params: unknown,
  shape: Record<string, unknown>,
): Array<{key: string; suggestion: string | null}> {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return [];
  }
  const known = Object.keys(shape);
  const knownSet = new Set([...known, 'timeout_ms']);
  const out: Array<{key: string; suggestion: string | null}> = [];
  for (const key of Object.keys(params as Record<string, unknown>)) {
    if (knownSet.has(key)) continue;
    out.push({key, suggestion: closestKey(key, known)});
  }
  return out;
}

/**
 * The declared parameter a typo most likely meant, or null when nothing is
 * close enough. Deliberately conservative: a wrong suggestion sends the caller
 * down a worse path than no suggestion.
 */
function closestKey(key: string, known: string[]): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestScore = Infinity;
  for (const candidate of known) {
    const c = candidate.toLowerCase();
    if (c === lower) return candidate;
    // Substring either way catches the common shapes: `shape` vs `properties`
    // is not a typo, but `class` vs `class_name` and `path` vs `paths` are.
    if (c.includes(lower) || lower.includes(c)) {
      const score = Math.abs(c.length - lower.length);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Refuse a tool call that passes a parameter the tool does not declare.
 *
 * This has to sit at the REQUEST level, not around the handler: the SDK builds
 * `z.object(shape)` from each tool's shape, and a plain `z.object` STRIPS
 * unknown keys, so by the time a handler runs the offending key is already
 * gone. Wrapping the handler therefore cannot see it — which is exactly why the
 * behaviour went unnoticed.
 *
 * The cost of ignoring it is a wrong answer that looks right. Measured:
 * `memlab_retainer_summary({class_name: "Object", typename: "CIXLoggerOutput"})`
 * — `retainer_summary` has no `typename`, so the filter silently vanished and
 * the call sampled 60 arbitrary `Object`s. The output was read as the retainer
 * structure of the typename population, and nothing in it said otherwise. A
 * caller cannot detect this by inspection; only the server can.
 *
 * `McpServer` installs its own `tools/call` handler lazily on first tool
 * registration, so this patches `setRequestHandler` (before any tool registers)
 * and wraps whatever handler is installed, rather than replacing it.
 */
function installUnknownParamRejection(server: McpServer): void {
  const inner = (server as unknown as {server?: {setRequestHandler?: AnyFn}})
    .server;
  if (inner == null || typeof inner.setRequestHandler !== 'function') {
    // A future SDK could restructure this. Losing the check is acceptable;
    // throwing here and taking the whole server down with it is not.
    return;
  }
  const origSet = inner.setRequestHandler.bind(inner) as AnyFn;
  (inner as {setRequestHandler: AnyFn}).setRequestHandler = (
    ...setArgs: unknown[]
  ) => {
    const [schema, handler, ...rest] = setArgs;
    if (typeof handler !== 'function') return origSet(...setArgs);
    const call = handler as AnyFn;
    const wrapped = async (request: unknown, extra: unknown) => {
      const req = request as
        | {method?: string; params?: {name?: string; arguments?: unknown}}
        | undefined;
      if (req?.method === 'tools/call' && req.params?.name != null) {
        const registered = getRegisteredTool(String(req.params.name));
        const shape = registered?.shape;
        if (shape != null) {
          const unknown = unknownParamNames(req.params.arguments, shape);
          if (unknown.length > 0) {
            return toolResult(
              unknownParamMessage(req.params.name, unknown, shape),
            );
          }
        }
      }
      return call(request, extra);
    };
    return origSet(schema, wrapped, ...rest);
  };
}

function unknownParamMessage(
  name: string,
  unknown: Array<{key: string; suggestion: string | null}>,
  shape: Record<string, unknown>,
): string {
  const listed = unknown
    .map(
      u =>
        `\`${u.key}\`` +
        (u.suggestion != null ? ` (did you mean \`${u.suggestion}\`?)` : ''),
    )
    .join(', ');
  return (
    `⚠ \`${name}\` does not accept ${listed}.\n\n` +
    'Refusing rather than ignoring it: an unknown parameter used to be dropped ' +
    'silently, so a filter that did not apply produced a plausible, ' +
    'confidently-formatted answer to a DIFFERENT question than the one asked.\n\n' +
    `Accepted parameters: ${Object.keys(shape)
      .sort()
      .map(k => `\`${k}\``)
      .join(', ')}.`
  );
}

/** Explanatory paragraphs shorter than this are never touched. */
const STANDING_NOTE_MIN_CHARS = 160;

/**
 * Drop explanatory paragraphs the session has already been shown.
 *
 * The same italic notes — what the Dev-only column means, why settle matters,
 * how newest-cohort voting works — printed on every call of every tool, and
 * a sweep calls `leak_report` dozens of times. A paragraph (blank-line
 * delimited) that starts with `_` or `> ` and is at least 160 characters is
 * keyed by its exact text: printed the first time, replaced by one pointer
 * line after that. A note carrying this call's numbers has different text
 * and still prints. Under the session `terse` flag, a long note is also cut to
 * its first sentence on first sight.
 */
function trimStandingNotes(result: unknown): unknown {
  if (process.env.MEMLAB_REPEAT_NOTES === '1') return result;
  const content = (result as {content?: Array<{type: string; text?: string}>})
    ?.content;
  if (!Array.isArray(content)) return result;
  const terse = isTerse();
  let dropped = 0;
  for (const c of content) {
    if (c.type !== 'text' || typeof c.text !== 'string') continue;
    if (c.text.trimStart().startsWith('{')) continue;
    const paras = c.text.split(/\n{2,}/);
    const kept: string[] = [];
    for (const para of paras) {
      const t = para.trim();
      const isNote =
        (t.startsWith('_') || t.startsWith('> ')) &&
        t.length >= STANDING_NOTE_MIN_CHARS;
      if (!isNote) {
        kept.push(para);
        continue;
      }
      const key = `para:${crypto.createHash('sha1').update(t).digest('hex')}`;
      if (!shouldEmitNote(key)) {
        dropped++;
        continue;
      }
      if (terse) {
        // A sentence end is a terminator before a capitalised word, a closing
        // `_`, or the end; `e.g.` and `run_dir.` mid-sentence are not one.
        const first = /^(.{40,}?[.!?])(?:\s+(?=[A-Z`*(])|_|$)/.exec(t);
        // Only a wholly italic note needs its closing underscore restored; one
        // that merely opens with an italic word would gain a stray `_`.
        const suffix = t.startsWith('_') && t.endsWith('_') ? '…_' : '…';
        // A cut inside `**bold**`, a code span or a link would leave it open
        // for the rest of the message; keep such a note whole.
        const count = (re: RegExp) => (first?.[1].match(re) ?? []).length;
        const balanced =
          first != null &&
          count(/\*\*/g) % 2 === 0 &&
          count(/`/g) % 2 === 0 &&
          count(/\[/g) === count(/\]/g) &&
          count(/\(/g) === count(/\)/g);
        kept.push(
          first != null && balanced && first[1].length < t.length
            ? `${first[1]}${suffix}`
            : para,
        );
      } else {
        kept.push(para);
      }
    }
    c.text = kept.join('\n\n');
  }
  if (dropped > 0) {
    content.push({
      type: 'text',
      text: `_(${dropped} explanatory note(s) already shown in this session were omitted; \`memlab_snapshots({repeat_notes: true})\` prints them again.)_`,
    });
  }
  return result;
}

export function installAnalysisGuardrail(server: McpServer): void {
  installUnknownParamRejection(server);
  const origTool = (server.tool as AnyFn).bind(server) as AnyFn;
  (server as unknown as {tool: AnyFn}).tool = (...toolArgs: unknown[]) => {
    const name = String(toolArgs[0]);
    const lastIdx = toolArgs.length - 1;
    const handler = toolArgs[lastIdx];
    if (typeof handler === 'function') {
      const inner = handler as AnyFn;
      // Index the raw handler plus its zod shape so tools can dispatch to each
      // other in-process without re-entering the budget, and without losing the
      // schema defaults the SDK would normally apply (see tool-registry.ts).
      // Registration is tool(name, description?, shape?, handler): the shape is
      // whatever plain object sits immediately before the handler.
      const maybeShape = lastIdx > 0 ? toolArgs[lastIdx - 1] : undefined;
      const shape =
        maybeShape != null &&
        typeof maybeShape === 'object' &&
        !Array.isArray(maybeShape)
          ? (maybeShape as Record<string, unknown>)
          : null;
      recordToolHandler(name, inner, shape);
      toolArgs[lastIdx] = async (...hArgs: unknown[]) => {
        // The SDK calls handler(args, extra) for schema tools, handler(extra)
        // otherwise. Read an optional per-call timeout_ms off the params.
        const params = hArgs[0];
        const override =
          params && typeof params === 'object' && 'timeout_ms' in params
            ? (params as {timeout_ms?: unknown}).timeout_ms
            : undefined;
        const timeoutMs = getAnalysisTimeoutMs(
          typeof override === 'number' ? override : undefined,
        );
        beginAnalysisBudget(timeoutMs);
        try {
          // `extra` is the second argument for a schema tool, the first
          // otherwise.
          const extra = hArgs.length > 1 ? hArgs[1] : hArgs[0];
          const result = await runWithProgress(
            makeProgressReporter(extra, name.replace(/^memlab_/, '')),
            async () => inner(...hArgs),
          );
          return trimStandingNotes(result);
        } catch (e) {
          if (e instanceof ScanTimeoutError) {
            const ran = Math.round(activeElapsedMs() / 1000);
            const limit = Math.round(timeoutMs / 1000);
            return toolResult(
              `⚠ Analysis stopped: \`${name}\` exceeded the ${limit}s guardrail (ran ~${ran}s) and was halted to keep the MCP server responsive. No complete result was produced.\n\n` +
                `This usually means the heap is very large. Options:\n` +
                `- Narrow the query with filters (min_count / min_self_size / min_retained_size / a specific name or type).\n` +
                `- For memlab_class_histogram, pass include_retained_size:false for an instant count + self-size histogram.\n` +
                `- Prefer targeted node-id tools (memlab_object_shape, memlab_trace_dominators, memlab_retainer_trace) or memlab_auto_investigate over whole-heap scans.\n` +
                `- Raise the limit for this call where supported (timeout_ms) or globally via the MEMLAB_ANALYSIS_TIMEOUT_MS env var (current default ${limit}s; set 0 to disable).`,
            );
          }
          throw e;
        } finally {
          endAnalysisBudget();
        }
      };
    }
    return origTool(...toolArgs);
  };
}
