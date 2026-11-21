// Card buttons use the same scoped shell tool and policy pipeline as agent calls.
import { importHost } from './host.mjs';
import { CARD_SHELL_SERVICE } from './environment.mjs';

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'zsh']);
export const STOP_TIMEOUT_MS = 30_000;

export async function runCardCommand(ctx, { agent, commandId, signal, command, description },
  loadPipeline = () => importHost('@deepseek-ai/dsh-tools/pipeline')) {
  // The preset registry resolves this against the agent's leased revision, not current settings.
  const configured = ctx.get?.('agentPresets')?.serviceFor?.(agent, CARD_SHELL_SERVICE);
  const candidates = ctx.tools.definitions(agent).filter(tool => SHELL_TOOLS.has(tool.name));
  const selected = configured === undefined
    ? candidates.length === 1 ? candidates[0] : undefined
    : configured.disabled ? undefined : candidates.find(tool => tool.name === configured.name);
  if (selected === undefined) throw new Error('The conversation does not have a single active Harness shell tool');

  const { ToolExecutionPipeline, executeToolBatch } = await loadPipeline();
  const pipeline = new ToolExecutionPipeline(ctx);
  const { results } = await executeToolBatch({
    agent,
    signal,
    calls: [{
      type: 'tool-call', id: commandId, name: selected.name,
      arguments: JSON.stringify({ command, description, timeoutMs: STOP_TIMEOUT_MS }),
    }],
  }, pipeline, () => 1);
  const result = results[0]?.result;
  if (result?.isError) throw new Error(result.error.message);

  const value = result?.value;
  if ((value?.kind === 'background' || value?.kind === 'promoted') && typeof value.jobId === 'string') {
    return { command: 'background', jobId: value.jobId };
  }
  if (value?.sandbox?.denied) throw new Error('The Harness sandbox denied the command');
  if (value?.aborted || value?.timedOut) throw new Error('The command was cancelled or timed out');
  if (value?.kind !== 'foreground' || value.exitCode !== 0) {
    throw new Error(value?.stderr?.text?.trim().split('\n')[0] || `The command failed (exit ${value?.exitCode ?? 'unknown'})`);
  }
  return { command: 'ok' };
}
