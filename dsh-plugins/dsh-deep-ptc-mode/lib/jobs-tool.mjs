import z from '@deepseek-ai/schemastery';
import { adaptContext, registering } from './adapt.mjs';
import { applyOfficial } from './host.mjs';
import { steerableJobs, steerableTool, steeringPending, steeringWatch } from './reachable.mjs';
import { approvalJobs } from './approval-jobs.mjs';

export const name = 'deep-ptc-tool-jobs';
export const inject = [];
export const Config = z.object({
  // The official job tool module and its options, as the installed PTC declaration names them.
  upstream: z.string().required(),
  options: z.any(),
  overrides: z.any(),
});

// The official job tools, with job_output waits ending when the user sends a message.
export async function apply(ctx, config) {
  const watch = steeringWatch(ctx);
  await applyOfficial(ctx, config.upstream, config.options, child => adaptContext(child, {
    tools: tools => registering(tools, definition => definition.name === 'job_output' ? steerableTool(withApprovalJobs(definition, watch)) : definition),
    jobs: jobs => steerableJobs(jobs, watch),
  }), config.overrides);
}

// job_output also reads approval jobs (lib/approval-jobs.mjs), in the official { text, job } shape. A
// wait ends early when the user writes, like every other Deep PTC wait.
function withApprovalJobs(definition, watch) {
  return {
    ...definition,
    async execute(args, exec) {
      if (!approvalJobs.isApprovalJob(args?.job_id)) return definition.execute(args, exec);
      const agent = exec.agent;
      const wait = args.wait === true && !steeringPending(agent);
      const steered = wait && agent ? watch.next(agent) : undefined;
      try {
        return await approvalJobs.read(agent?.id, args.job_id, { wait, timeoutMs: args.timeout_ms, steered: steered?.promise });
      } finally { steered?.dispose(); }
    },
  };
}
