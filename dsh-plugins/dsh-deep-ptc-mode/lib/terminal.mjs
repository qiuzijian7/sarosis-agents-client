import z from '@deepseek-ai/schemastery';
import { adaptContext, registering } from './adapt.mjs';
import { applyOfficial } from './host.mjs';
import { finishPromoted, steerableJobs, steerableTool, steeringWatch } from './reachable.mjs';

export const name = 'deep-ptc-terminal';
export const inject = [];
export const Config = z.object({
  // The official shell tool module and its options, as the installed PTC declaration names them.
  upstream: z.string().required(),
  options: z.any(),
  dialect: z.union(['zsh']),
});

// Run the official shell tool with its own execution, jobs and approval implementation. Foreground
// waits yield to user messages; the Zsh dialect only renames the tool's public face.
export async function apply(ctx, config) {
  const watch = steeringWatch(ctx);
  const zsh = config.dialect === 'zsh';
  const dialect = text => zsh ? text.replace(/\bbash\b/gu, 'zsh').replace(/\bBash\b/gu, 'Zsh') : text;
  await applyOfficial(ctx, config.upstream, config.options, child => adaptContext(child, {
    tools: tools => registering(tools, definition => steerableTool({
      ...definition,
      ...zsh ? { name: definition.name === 'bash' ? 'zsh' : definition.name, description: dialect(definition.description) } : {},
    }, finishPromoted)),
    systemPrompt: prompt => zsh ? new Proxy(prompt, {
      get(target, key) {
        if (key === 'section') return section => target.section({ ...section,
          name: section.name === 'tool:bash' ? 'tool:zsh' : section.name, text: dialect(section.text) });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) : prompt,
    jobs: jobs => steerableJobs(jobs, watch),
  }));
}
