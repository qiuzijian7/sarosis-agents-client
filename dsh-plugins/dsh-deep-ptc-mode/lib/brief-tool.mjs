// The task_brief tool as a Deep PTC preset row, so only Deep PTC conversations see it. The row shares
// the profile-level runtime that lib/brief-context.mjs installs.
import { briefToolDefinition } from './brief-context.mjs';

export const name = 'deep-ptc-brief-tool';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(briefToolDefinition()), 'Deep PTC: task brief tool');
}
