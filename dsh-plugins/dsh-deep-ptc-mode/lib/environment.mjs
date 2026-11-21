import z from '@deepseek-ai/schemastery';
import { environmentText } from './model.mjs';
export const name = 'deep-ptc-execution-instructions';
export const CARD_SHELL_SERVICE = 'deepPtcCardShell';
export const inject = ['systemPrompt'];
export const Config = z.object({
  environment: z.union(['wsl', 'powershell', 'zsh', 'bash']).required(),
  wslDistribution: z.string().default(''),
  shellNote: z.string().default(''),
  // The shell tool row is disabled (disabledShellTools, #23); tell the model which tool to use.
  shellToolHidden: z.boolean().default(false),
  // SSH guidance for this environment (lib/ssh.mjs); empty omits the section.
  ssh: z.string().default(''),
});
export function apply(ctx, config) {
  const shell = config.environment === 'powershell' ? 'pwsh' : config.environment === 'zsh' ? 'zsh' : 'bash';
  ctx.provide(CARD_SHELL_SERVICE, { name: shell, disabled: config.shellToolHidden });
  ctx.systemPrompt.section({
    name: 'deep-ptc:execution-environment', order: 10190,
    text: environmentText(config.environment, config.wslDistribution, config.shellNote, process.platform, config.shellToolHidden),
  });
  if (config.ssh) ctx.systemPrompt.section({ name: 'deep-ptc:ssh', order: 10191, text: config.ssh });
}
