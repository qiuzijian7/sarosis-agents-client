import { AsyncLocalStorage } from 'node:async_hooks';

// A user message steered into a running turn is only read at the next step boundary. These helpers let a
// tool call that is waiting on a job or a question stop waiting once such a message arrives; the job keeps
// running in the background and its completion notice still wakes the agent.
export const YIELD_GRACE_MS = 2000;
const calls = new AsyncLocalStorage();

export function steeringPending(agent) {
  return agent?.inbox?.nextStep?.some(message => message.source?.kind === 'user') ?? false;
}

// One inbox subscription per plugin; waiters are keyed by agent id.
export function steeringWatch(ctx) {
  const waiters = new Map();
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind !== 'user' || !agent?.inbox?.nextStep?.some(row => row.id === message.id)) return;
    for (const wake of waiters.get(agent.id) ?? []) wake();
  });
  return {
    next(agent) {
      let wake;
      const promise = new Promise(resolve => { wake = resolve; });
      const set = waiters.get(agent.id) ?? new Set();
      set.add(wake);
      waiters.set(agent.id, set);
      return { promise, dispose() { set.delete(wake); if (set.size === 0) waiters.delete(agent.id); } };
    },
  };
}

// Run a tool body inside a call scope so the jobs facade can recognise the call's own waits.
export function steerableTool(definition, finish = value => value) {
  return {
    ...definition,
    async execute(args, exec) {
      const call = { exec, started: Date.now(), yieldedAt: undefined };
      const value = await calls.run(call, () => definition.execute(args, exec));
      return call.yieldedAt === undefined ? value : finish(value, call.yieldedAt - call.started);
    },
  };
}

// A bash/pwsh result promoted because the user spoke reports the real elapsed time, not the timeout.
export function finishPromoted(value, elapsedMs) {
  return value?.kind === 'promoted' ? { ...value, timeoutMs: Math.max(1, elapsedMs) } : value;
}

export function steerableJobs(jobs, watch) {
  return new Proxy(jobs, {
    get(target, key) {
      if (key === 'wait') return (id, timeoutMs, owner, signal) => steerableWait(target, watch, id, timeoutMs, owner, signal);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function steerableWait(jobs, watch, id, timeoutMs, owner, signal) {
  const call = calls.getStore();
  const agent = call?.exec.agent;
  // Settlement waits after a kill carry no signal and keep their full semantics.
  if (agent === undefined || signal === undefined || signal !== call.exec.signal || agent.id !== owner)
    return jobs.wait(id, timeoutMs, owner, signal);
  const yieldToUser = () => {
    call.yieldedAt ??= Date.now();
    return jobs.wait(id, Math.min(timeoutMs, YIELD_GRACE_MS), owner, signal);
  };
  if (steeringPending(agent)) return yieldToUser();
  const local = new AbortController();
  const forward = () => local.abort(signal.reason);
  signal.addEventListener('abort', forward, { once: true });
  const steered = watch.next(agent);
  try {
    const waited = jobs.wait(id, timeoutMs, owner, local.signal).then(view => ({ view }));
    waited.catch(() => {});
    const outcome = await Promise.race([waited, steered.promise.then(() => ({ steered: true }))]);
    if (!outcome.steered) return outcome.view;
    local.abort('user message');
    return yieldToUser();
  } finally {
    steered.dispose();
    signal.removeEventListener('abort', forward);
  }
}

// Timed questions become pending as soon as the user writes instead of answering the card. The service
// keeps no public early-expiry hook, so this reaches its wait record. If an update reshapes that record the
// question simply waits out its timeout as it does officially, and `reshaped` is told.
export function steerableQuestions(questions, watch, reshaped = () => {}) {
  return new Proxy(questions, {
    get(target, key) {
      if (key !== 'askTimed') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (request, callId, timeoutMs) => {
        const asked = target.askTimed(request, callId, timeoutMs);
        if (request?.agent === undefined) return asked;
        const expire = () => {
          const report = () => {
            try { reshaped(); } catch { /* diagnostics must not interrupt the official wait */ }
          };
          try {
            const waits = target.waits;
            if (typeof waits?.get !== 'function') return report();
            const records = waits.get(request.agent);
            if (records == null) return;
            if (typeof records.get !== 'function') return report();
            // No record means the question was already answered or expired.
            const wait = records.get(callId);
            if (wait == null) return;
            if (typeof wait.close !== 'function' || wait.timeout === undefined) return report();
            wait.close(wait.timeout);
          } catch {
            report();
          }
        };
        if (steeringPending(request.agent)) {
          expire();
          return asked;
        }
        const steered = watch.next(request.agent);
        steered.promise.then(expire);
        return asked.finally(() => steered.dispose());
      };
    },
  });
}
