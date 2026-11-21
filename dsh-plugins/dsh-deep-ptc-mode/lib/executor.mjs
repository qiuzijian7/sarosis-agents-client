import z from '@deepseek-ai/schemastery';
import { importHost, pluginOf } from './host.mjs';
import { extensible, mappedExecutor } from './mapped-shell.mjs';

export const name = 'deep-ptc-mapped-executor';
export const inject = [];
export const Config = z.object({
  environment: z.union(['wsl', 'zsh', 'bash']).required(),
  wslDistribution: z.string().default(''),
  shellExecutable: z.string().default(''),
  // The official bash executor module and its options, as the installed base declaration names them.
  base: z.string().required(),
  options: z.any(),
});

export async function apply(ctx, config) {
  const Base = pluginOf(await importHost(config.base));
  if (!extensible(Base))
    throw new Error(`${config.base} no longer exposes the executor API Deep PTC extends; choose PowerShell or native Bash`);
  ctx.plugin(mappedExecutor(Base, config.environment, config.wslDistribution, config.shellExecutable), config.options);
}
