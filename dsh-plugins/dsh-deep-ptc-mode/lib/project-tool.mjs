// The project_cards tool as a Deep PTC preset row, so only Deep PTC conversations see it. Other
// conversations still read the cards in their system prompt (lib/project-context.mjs), read-only.
//
// The row shares the profile-level runtime (store, session mirror) that project-context.mjs
// installs; until that runtime is ready, the tool answers with a clear error instead of guessing.
import { projectToolDefinition } from './project-context.mjs';

export const name = 'deep-ptc-project-tool';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(projectToolDefinition()), 'Deep PTC: project cards tool');
}
