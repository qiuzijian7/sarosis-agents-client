import z from '@deepseek-ai/schemastery';
import { adaptContext } from './adapt.mjs';
import { applyOfficial } from './host.mjs';
import { steerableQuestions, steeringWatch } from './reachable.mjs';

export const name = 'deep-ptc-tool-ask-user';
export const inject = [];
export const Config = z.object({
  // The official question tool module and its options, as the installed PTC declaration names them.
  upstream: z.string().required(),
  options: z.any(),
  overrides: z.any(),
});

// The official question tool. In timed mode a question the user leaves unanswered becomes pending,
// and a message the user writes instead ends the wait early.
export async function apply(ctx, config) {
  const watch = steeringWatch(ctx);
  let warned = false;
  const reshaped = () => {
    if (!warned) ctx.logger.warn('Deep PTC: the question service changed shape; a question the user writes past now waits out its timeout');
    warned = true;
  };
  await applyOfficial(ctx, config.upstream, config.options, child => adaptContext(child, {
    userQuestions: questions => steerableQuestions(questions, watch, reshaped),
  }), config.overrides);
}
