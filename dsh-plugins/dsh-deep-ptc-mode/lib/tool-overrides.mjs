import z from '@deepseek-ai/schemastery';

const namePattern = /^[A-Za-z0-9_.:-]{1,128}$/u;
const transport = 'run_code';

export const name = 'deep-ptc-tool-overrides';
export const inject = ['tools', 'systemPrompt'];
export const overrideRows = z.array(z.object({
  tool: z.string().required(),
  row: z.string().default(''),
  replacement: z.string().default(''),
})).default([]);
export const Config = z.object({ overrides: overrideRows });

export function normalizeToolOverrides(value) {
  if (!Array.isArray(value)) return [];
  const overrides = new Map();
  for (const entry of value.slice(0, 32)) {
    if (typeof entry?.tool !== 'string' || !namePattern.test(entry.tool) || entry.tool === transport) continue;
    const row = typeof entry.row === 'string' && namePattern.test(entry.row) ? entry.row : '';
    const replacement = typeof entry.replacement === 'string' && namePattern.test(entry.replacement)
      && entry.replacement !== entry.tool && entry.replacement !== transport ? entry.replacement : '';
    overrides.set(entry.tool, { tool: entry.tool, row, replacement });
  }
  return [...overrides.values()];
}

export function apply(ctx, config) {
  const overrides = normalizeToolOverrides(config.overrides);
  if (overrides.length === 0) return;
  const hidden = new Set(overrides.map(entry => entry.tool));
  ctx.tools.guard(exec => hidden.has(exec.name) ? `Deep PTC: ${exec.name} is disabled by this preset's tool configuration.` : undefined);

  // The host rejects restrictions on unknown names. Follow the global registrations as plugins load.
  let masked = '';
  let changing = false;
  let release;
  function sync() {
    if (changing || typeof ctx.tools.restrict !== 'function') return;
    const deny = [...hidden].filter(tool => ctx.tools.get(tool) !== undefined).sort();
    const key = deny.join('\0');
    if (key === masked) return;
    changing = true;
    try {
      const next = deny.length ? ctx.tools.restrict({ deny }) : undefined;
      release?.();
      release = next;
      masked = key;
    } catch (error) {
      ctx.logger.warn('Deep PTC: could not update inherited tool visibility (%s)', error.message);
    } finally {
      changing = false;
    }
  }
  ctx.on('tools/change', sync);
  ctx.effect(() => () => {
    changing = true;
    release?.();
  });
  sync();

  ctx.systemPrompt.section({
    name: 'deep-ptc:tool-overrides',
    order: 10196,
    text: ({ agent, scope, toolSet }) => {
      const lines = overrides.map(({ tool, replacement }) => {
        if (!replacement) return `\`${tool}\` is disabled by this preset.`;
        const available = ctx.tools.get(replacement, agent ?? scope, toolSet) !== undefined;
        return available
          ? `\`${tool}\` is disabled. Use \`${replacement}\` for the same task where its live contract applies; load its schema if needed.`
          : `\`${tool}\` is disabled and the configured replacement \`${replacement}\` is unavailable in this request.`;
      });
      return ['## Tools configured for this preset', ...lines].join('\n');
    },
  });
}
