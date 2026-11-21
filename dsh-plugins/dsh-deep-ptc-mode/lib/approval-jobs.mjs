// Sandbox escalations as approval jobs: an escalation never blocks the model.
//
// A shell call that asks for a wider sandbox (sandbox_permissions + justification) needs the user's
// approval. Left alone, the host parks the call — and a whole run_code program — on the approval
// prompt, and the model cannot tell "waiting for a human" from "hung". Instead, the guard starts the
// same call as a deferred job through the host's own tool pipeline and answers at once with a handle.
// The approval prompt appears as usual; the command runs as soon as the user approves; job_output
// reports the state (waiting for approval, running, done, rejected, cancelled, failed) and the output.

import { importHost } from './host.mjs';

export const APPROVAL_PREFIX = 'approval-';
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'zsh']);
const MAX_JOBS = 50;
const MAX_TEXT = 8000;
const WAIT_CAP_MS = 30_000;

/** Whether a call asks for a sandbox escalation the user must approve. */
export function isEscalation(exec) {
  const args = exec?.arguments ?? {};
  return SHELL_TOOLS.has(exec?.name) && typeof args.sandbox_permissions === 'string' && args.sandbox_permissions !== ''
    && typeof args.justification === 'string' && args.justification.trim() !== '';
}

const clip = (value, max = MAX_TEXT) => {
  const text = String(value ?? '');
  return text.length > max ? `…${text.slice(-max)}` : text;
};

/**
 * The registry and its behaviour. One instance per process: the guard row creates jobs and the job
 * tool row reads them. Injectable pieces keep it testable.
 * @param options - `{ loadPipeline, now }`.
 */
export function createApprovalJobs({ loadPipeline = () => importHost('@deepseek-ai/dsh-tools/pipeline'), now = () => Date.now() } = {}) {
  const jobs = new Map();
  const byCall = new Map();
  const deferred = new Set();
  let seq = 0;
  let watching = false;

  const settle = (job, patch) => {
    if (job.done) return;
    Object.assign(job, patch, { done: ['completed', 'failed', 'rejected', 'cancelled'].includes(patch.state) ? true : job.done });
    if (job.done) { job.finishedAt ??= now(); job.wake(); }
  };

  /** Follow approval events in the session log: asked → waiting, decided → running or rejected. */
  function watch(ctx) {
    if (watching || typeof ctx.on !== 'function') return;
    watching = true;
    const asked = new Map();
    ctx.on('session/event', (_session, event) => {
      if (event?.type === 'approval/asked') {
        const job = byCall.get(event.data?.callId);
        if (job) { asked.set(event.data.id, job); settle(job, { state: 'waiting', askedAt: event.time ?? now() }); }
      } else if (event?.type === 'approval/decided') {
        const job = asked.get(event.data?.id);
        if (!job) return;
        asked.delete(event.data.id);
        const outcome = event.data?.outcome;
        if (outcome === 'allowed-once') settle(job, { state: 'running', decidedAt: event.time ?? now() });
        else settle(job, { state: outcome === 'rejected' ? 'rejected' : 'cancelled', reason: `approval ${outcome}` });
      }
    }, { global: true });
  }

  /**
   * Called by the guard for every tool call. Starts an approval job for an escalation and returns the
   * text the model sees instead of waiting; returns undefined for everything else.
   */
  function intercept(ctx, exec) {
    if (!isEscalation(exec) || deferred.has(exec.callId) || exec.agent === undefined) return undefined;
    watch(ctx);
    const id = `${APPROVAL_PREFIX}${++seq}`;
    const callId = `${id}-${now().toString(36)}`;
    let wake;
    const settled = new Promise(resolve => { wake = resolve; });
    const args = exec.arguments;
    const job = { id, agentId: exec.agent.id, tool: exec.name, command: clip(args.command, 300), mode: args.sandbox_permissions,
      state: 'starting', startedAt: now(), settled, wake, done: false };
    jobs.set(id, job);
    byCall.set(callId, job);
    deferred.add(callId);
    while (jobs.size > MAX_JOBS) {
      const oldest = [...jobs.values()].find(row => row.done);
      if (!oldest) break;
      jobs.delete(oldest.id);
    }
    const abort = new AbortController();
    job.abort = abort;
    void (async () => {
      try {
        const { ToolExecutionPipeline, executeToolBatch } = await loadPipeline();
        const { results } = await executeToolBatch({ agent: exec.agent, signal: abort.signal,
          calls: [{ type: 'tool-call', id: callId, name: exec.name, arguments: JSON.stringify(args) }] }, new ToolExecutionPipeline(ctx), () => 1);
        const result = results[0]?.result;
        if (result?.isError) {
          const message = String(result.error?.message ?? 'failed');
          settle(job, { state: /reject|denied by the user|not approved/iu.test(message) ? 'rejected' : job.state === 'waiting' ? 'cancelled' : 'failed', reason: clip(message, 600) });
          return;
        }
        const value = result?.value ?? {};
        if ((value.kind === 'background' || value.kind === 'promoted') && typeof value.jobId === 'string') {
          settle(job, { state: 'completed', handoff: value.jobId, output: `Moved to background job ${value.jobId}.` });
          return;
        }
        const output = [value.stdout?.text, value.stderr?.text ? `[stderr]\n${value.stderr.text}` : ''].filter(Boolean).join('\n');
        settle(job, { state: value.exitCode === 0 ? 'completed' : 'failed', exitCode: value.exitCode, output: clip(output) });
      } catch (error) {
        settle(job, { state: 'failed', reason: clip(error?.message ?? error, 600) });
      } finally {
        deferred.delete(callId);
        byCall.delete(callId);
      }
    })();
    return `Sandbox escalation started as approval job ${id}. The user is being asked to approve this ${exec.name} command with ${args.sandbox_permissions}; `
      + 'it has not run yet and runs as soon as they approve. This call returns now so you are not blocked. '
      + `Tell the user an approval is waiting, continue work that does not depend on it, and check job_output({ job_id: "${id}", wait: true }) before you end your turn.`;
  }

  /** The job_output value for an approval job: the official { text, job } shape. */
  function view(job) {
    const elapsed = Math.round(((job.finishedAt ?? now()) - (job.askedAt ?? job.startedAt)) / 1000);
    const status = job.state === 'completed' ? 'completed' : job.state === 'failed' ? 'failed'
      : job.state === 'rejected' || job.state === 'cancelled' ? 'killed' : 'running';
    const detail = {
      starting: 'starting the approval request',
      waiting: `waiting for the user's approval for ${elapsed} s; the command has not run`,
      running: 'approved; the command is running',
      completed: job.handoff ? `approved; continued as background job ${job.handoff}` : `approved and finished (exit ${job.exitCode ?? 0})`,
      failed: `approved but failed${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}${job.reason ? `: ${job.reason}` : ''}`,
      rejected: 'the user rejected the approval; the command did not run',
      cancelled: `the approval was withdrawn; the command did not run${job.reason ? ` (${job.reason})` : ''}`,
    }[job.state] ?? job.state;
    const text = [`${job.id} · ${job.tool} · ${detail}`, job.output ?? ''].filter(Boolean).join('\n');
    return { text, job: { id: job.id, kind: 'approval', label: `${job.tool}: ${job.command}`.slice(0, 200), status, detail,
      startedAt: job.startedAt, ...job.finishedAt ? { finishedAt: job.finishedAt } : {} } };
  }

  /** Read (and optionally wait for) an approval job; a wait ends early when `steered` resolves. */
  async function read(agentId, id, { wait = false, timeoutMs = WAIT_CAP_MS, steered } = {}) {
    const job = jobs.get(id);
    if (!job || job.agentId !== agentId) throw new Error(`Unknown approval job ${id}`);
    if (wait && !job.done) {
      let timer;
      await Promise.race([job.settled, new Promise(resolve => { timer = setTimeout(resolve, Math.min(Math.max(1, timeoutMs), WAIT_CAP_MS)); }), steered ?? new Promise(() => {})]);
      clearTimeout(timer);
    }
    return view(job);
  }

  const list = agentId => [...jobs.values()].filter(job => job.agentId === agentId).map(job => view(job).job);
  return { intercept, read, list, isApprovalJob: id => typeof id === 'string' && id.startsWith(APPROVAL_PREFIX) };
}

/** The process-wide registry the preset rows share. */
export const approvalJobs = createApprovalJobs();
