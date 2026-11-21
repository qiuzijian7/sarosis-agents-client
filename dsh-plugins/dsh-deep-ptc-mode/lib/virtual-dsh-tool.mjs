// The virtual_dsh tool as a Deep PTC preset row, present only in deep creative mode. It shares the
// profile-level runtime that lib/virtual-dsh.mjs installs.
import { virtualToolDefinition } from './virtual-dsh.mjs';

export const name = 'deep-ptc-virtual-dsh-tool';
export const inject = ['tools'];

export function apply(ctx) {
  // The host's approval service, read at call time: the first change or test asks the user once.
  ctx.effect(() => ctx.tools.register(virtualToolDefinition(undefined, { approval: () => ctx.get?.('approval') ?? ctx.approval })), 'Deep PTC: virtual DSH tool');
}
