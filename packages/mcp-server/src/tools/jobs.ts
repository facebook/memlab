/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @oncall memory_lab
 */

/**
 * Run any tool as a background job and poll for it.
 *
 * Ladder tools routinely run past an MCP client's ~120 s tool timeout (six
 * rungs of 500 MB is minutes of parsing), and the client then backgrounds the
 * call with no progress and no way back to its result except waiting.
 * `memlab_analysis_battery` solved that for itself with `async: true`; this is
 * the same thing for every tool, without each one growing its own job table.
 *
 * Honest limit: memlab's parse and dominator passes are synchronous, so a
 * status call made while a job is inside one is answered when that pass ends.
 * It never fails — it waits — and the job's notes say which rung it is on.
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'crypto';
import {z} from 'zod';
import {runWithProgress, type ProgressReporter} from '../progress.js';
import {getRegisteredTool, listToolNames} from '../tool-registry.js';
import {errorResult, markdownTable, toolResult} from '../utils.js';

interface Job {
  id: string;
  tool: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'error';
  notes: string[];
  result: unknown;
  /** The finished result has been returned by memlab_job_status. */
  retrieved: boolean;
}

const MAX_JOBS = 50;
// No tool runs this long; a job still "running" past it awaits something that
// will never settle, and must not hold a slot forever.
const JOB_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const jobs = new Map<string, Job>();

function textOf(result: unknown): string {
  const content = (result as {content?: Array<{type: string; text?: string}>})
    ?.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n');
}

function elapsed(job: Job): string {
  return `${Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)}s`;
}

export function registerJobs(server: McpServer): void {
  server.tool(
    'memlab_start_job',
    'Start ANY memlab tool as a background job and return a job id at once; collect the result with `memlab_job_status`. Use it for ladder tools (leak_report, detached_dom / event_registry with run_dir, ladder_probe, replicate, shape_census_diff, collection_diff, …) that would otherwise run past the client tool timeout and be backgrounded with no progress. The job records a note per rung loaded. A job still running after 6 h is marked abandoned, which frees its slot but does not stop a synchronous parse already under way.',
    {
      tool: z.string().describe('Tool name, e.g. "memlab_leak_report".'),
      args: z
        .record(z.unknown())
        .optional()
        .default({})
        .describe("That tool's arguments, exactly as for a direct call."),
    },
    async ({tool, args}) => {
      try {
        const entry = getRegisteredTool(tool);
        if (entry == null) {
          return errorResult(
            new Error(
              `unknown tool \`${tool}\`. Known: ${listToolNames().join(', ')}`,
            ),
          );
        }
        if (tool === 'memlab_start_job' || tool === 'memlab_job_status') {
          return errorResult(new Error('a job cannot start a job'));
        }
        const parsed =
          entry.shape != null
            ? z.object(entry.shape as never).parse(args)
            : args;
        const job: Job = {
          id: crypto.randomBytes(4).toString('hex'),
          tool,
          startedAt: Date.now(),
          finishedAt: null,
          status: 'running',
          notes: [],
          result: null,
          retrieved: false,
        };
        if (jobs.size >= MAX_JOBS) {
          // Only a result someone has read is safe to drop; evicting an unread
          // one loses the analysis the job existed to deliver. An unread one
          // older than JOB_MAX_AGE_MS was abandoned by its caller, though, and
          // must not hold a slot forever.
          const now = Date.now();
          const oldest = [...jobs.values()]
            .filter(
              j =>
                j.status !== 'running' &&
                (j.retrieved || now - (j.finishedAt ?? now) > JOB_MAX_AGE_MS),
            )
            .sort((a, b) => a.startedAt - b.startedAt)[0];
          if (oldest == null) {
            return errorResult(
              new Error(
                `${MAX_JOBS} jobs are running or hold unread results; collect finished ones with memlab_job_status first`,
              ),
            );
          }
          jobs.delete(oldest.id);
        }
        jobs.set(job.id, job);
        const reporter: ProgressReporter = {
          phase: (step, total, message) =>
            job.notes.push(`[${elapsed(job)}] ${step}/${total} ${message}`),
          note: message => job.notes.push(`[${elapsed(job)}] ${message}`),
        };
        // Deliberately not awaited: the point is to return before the work.
        // No sendNotification in `extra`: the reporter above is the job's
        // progress channel, and one built from `extra` would replace it.
        const controller = new AbortController();
        const extra = {signal: controller.signal};
        // Enforced on a timer, not on the next start_job: a handler awaiting
        // something that never settles would otherwise read "running" forever.
        // This only marks the job and frees its slot. abort() cannot stop a
        // synchronous parse or dominator pass, so the work (and its snapshot
        // memory) runs on until that pass returns.
        const abandon = setTimeout(() => {
          if (job.status !== 'running') return;
          controller.abort();
          job.status = 'error';
          job.finishedAt = Date.now();
          // Read or not, it may be evicted.
          job.retrieved = true;
          job.result = errorResult(
            new Error(
              `abandoned after ${JOB_MAX_AGE_MS / 3600000} h without finishing`,
            ),
          );
        }, JOB_MAX_AGE_MS);
        abandon.unref();
        void runWithProgress(reporter, async () => entry.handler(parsed, extra))
          // finishedAt is set WITH the status, so no poll sees a finished job
          // whose elapsed time is still running.
          // An abandoned job stays abandoned: it may already have been evicted.
          .then(result => {
            if (job.status !== 'running') return;
            job.result = result;
            job.finishedAt = Date.now();
            job.status = (result as {isError?: boolean})?.isError
              ? 'error'
              : 'done';
          })
          .catch((err: unknown) => {
            if (job.status !== 'running') return;
            job.result = errorResult(err);
            job.finishedAt = Date.now();
            job.status = 'error';
          })
          .finally(() => clearTimeout(abandon));
        return toolResult(
          `Started \`${tool}\` as job \`${job.id}\`. Poll with ` +
            `\`memlab_job_status({job_id: "${job.id}"})\`.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'memlab_job_status',
    'Report on a job started with `memlab_start_job`, and return its full result once it has finished. With no `job_id`, lists every job this server knows about.',
    {
      job_id: z
        .string()
        .optional()
        .describe('The id `memlab_start_job` returned.'),
    },
    async ({job_id}) => {
      if (job_id == null || job_id === '') {
        if (jobs.size === 0) {
          return toolResult(
            'No jobs have been started in this server process.',
          );
        }
        return toolResult(
          markdownTable(
            ['Job', 'Tool', 'Status', 'Elapsed', 'Last note'],
            [...jobs.values()].map(j => [
              j.id,
              j.tool,
              j.status,
              elapsed(j),
              j.notes[j.notes.length - 1] ?? '—',
            ]),
          ),
        );
      }
      const job = jobs.get(job_id);
      if (job == null) {
        return errorResult(
          new Error(`no job \`${job_id}\` in this server process`),
        );
      }
      const header = `Job \`${job.id}\` (\`${job.tool}\`): **${job.status}** after ${elapsed(job)}.`;
      if (job.status === 'running') {
        return toolResult(
          [header, '', ...job.notes.slice(-8).map(n => `- ${n}`)].join('\n'),
        );
      }
      job.retrieved = true;
      return toolResult([header, '', textOf(job.result)].join('\n'));
    },
  );
}
