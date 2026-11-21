import z from '@deepseek-ai/schemastery';
import { reachabilityGuard, reachabilityText } from './rules.mjs';
import { failOpen } from './tool-policy.mjs';
import { approvalJobs } from './approval-jobs.mjs';

export const name = 'deep-ptc-reachability-guard';
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({
  foregroundSeconds: z.number().min(5).max(600).default(30),
  maxQuestionSeconds: z.number().min(10).max(3600).default(300),
  maxPollsPerProgram: z.number().min(1).max(100).default(3),
  // Question cards replace ask_user_question while conversation cards are on.
  questionCards: z.boolean().default(false),
});

export function apply(ctx, config) {
  const reachable = reachabilityGuard(config, () => ctx.get('jobs'), () => ctx.get('ptcRuntime')?.language);
  // An escalation becomes an approval job first, so no call ever parks on the approval prompt.
  ctx.tools.guard(failOpen(ctx, 'reachability guard', exec => approvalJobs.intercept(ctx, exec) ?? reachable(exec)));
  ctx.systemPrompt.section({ name: 'deep-ptc:reachability', order: 10195, text: reachabilityText(config) });
}
