// The ask_user tool as a Deep PTC preset row: question cards replace the host's blocking question box
// in Deep PTC, while other modes keep their own question tool. The row shares the profile-level card
// runtime that lib/cards-context.mjs installs.
import { questionToolDefinition } from './cards-context.mjs';

export const name = 'deep-ptc-question-tool';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(questionToolDefinition()), 'Deep PTC: question cards');
}
