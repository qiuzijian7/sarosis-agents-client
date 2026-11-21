import z from '@deepseek-ai/schemastery';
import { failOpen, installToolCompatibility, officialToolSource } from './tool-policy.mjs';
import { importHost } from './host.mjs';
import { toolDirectory } from './official-names.mjs';
import { DIRECTORY_TOOL, RESET_COMMAND, STATE_EVENT, searchCatalog, toolSchema } from './tool-catalog.mjs';
import { registerState, resetText, rootToolState, sessionRecords } from './tool-state.mjs';

export const name = 'deep-ptc-tool-compatibility';
// Discovery and quarantine are an optional layer: a failed preset row rejects the whole preset mount,
// and a row waiting on a service is reported as unusable. So this row needs nothing itself and runs the
// layer in a child fiber; if that fails or never starts, the official PTC tools simply stay as they are.
export const inject = [];
const REQUIRED = ['tools', 'systemPrompt', 'commands', 'sessionProjections'];
export const Config = z.object({ enabled: z.boolean().default(true), preferences: z.any().default([]),
  compact: z.boolean().default(true), officialModules: z.any().default([]), sdkProvider: z.string().default('@deepseek-ai/dsh-tool-executor-ptc'),
  skillProvider: z.string().default('@deepseek-ai/dsh-tool-skill') });

export function apply(ctx, config) {
  if (!config.enabled) return;
  const missing = REQUIRED.filter(service => ctx.get(service) === undefined);
  if (missing.length > 0) ctx.logger.info('Deep PTC: tool discovery and quarantine wait for %s', missing.join(', '));
  ctx.plugin({ name: 'deep-ptc-tool-compatibility-layer', inject: REQUIRED, apply: child => install(child, config) }).await()
    .catch(error => ctx.logger.warn('Deep PTC: tool discovery and quarantine are off (%s); official tools are unaffected', error.message));
}

async function install(ctx, config) {
  const root = rootToolState();
  let projection = root?.projection;
  let write = root?.write;
  if (root === undefined) {
    const appendPluginRecord = await sessionRecords();
    projection = await registerState(ctx);
    ctx.effect(() => () => projection.dispose());
    write = (session, value) => appendPluginRecord(session, STATE_EVENT, value);
  }
  const directory = toolDirectory(() => ctx.get('loader'), { modules: config.officialModules, base: ctx.baseUrl });
  const state = installToolCompatibility(ctx, { preferences: config.preferences, directory, storage: {
    read: session => projection.stateOf(session),
    write,
  } });
  if (root === undefined) ctx.commands.register({ name: RESET_COMMAND, description: '重载所有工具状态 / Reload all tool states',
    handler: ({ agent }) => ({ kind: 'success', text: resetText(state.reset(agent)) }) });
  ctx.tools.register({ name: DIRECTORY_TOOL,
    description: 'Find tools or skills by function without loading all schemas. search returns compact tool summaries; load reveals complete schemas for selected tool names; skills returns summaries to load with the official skill tool. Never executes task tools or reads skill bodies.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ['search', 'load', 'skills'] }, query: { type: 'string' },
      names: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer' }, limit: { type: 'integer' },
    }, required: ['action'] },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (args.action === 'load') return state.load(exec.agent, args.names, exec.toolSet);
      if (args.action === 'search') return state.search(exec.agent, args, exec.toolSet);
      if (args.action !== 'skills') throw new Error('Unknown directory action');
      const skills = ctx.get('skills');
      const loader = ctx.tools.definitions(exec.agent, exec.toolSet).find(def => officialToolSource(def) === config.skillProvider || directory.namesOf(config.skillProvider).has(def.name));
      if (typeof skills?.list !== 'function' || !loader) return { available: false, results: [], note: 'The official skill loader is unavailable.' };
      const { isModelInvocable } = await importHost('@deepseek-ai/dsh-skill').catch(() => ({}));
      if (typeof isModelInvocable !== 'function') return { available: false, results: [], note: 'The official skill loader is unavailable.' };
      const workingDirectory = ctx.get('workingDirectory');
      const lookup = { scope: exec.agent, signal: exec.signal, cwd: workingDirectory ? await workingDirectory.ensure(exec.agent, exec.signal) : undefined };
      const entries = (await skills.list(lookup)).filter(isModelInvocable).map(row => ({ name: row.name, description: row.description ?? '' }));
      return { available: true, ...searchCatalog(entries, args.query, args.offset, args.limit), loadWith: loader.name,
        note: 'Load the exact selected name through the official skill tool, then follow its instructions. Reuse instructions already in context.' };
    },
  });
  // Only reduce the installed official renderer's untouched generated SDK section.
  let renderer;
  const sdkCache = new WeakMap();
  const same = (left, right) => left?.length === right.length && left.every((def, index) => def === right[index]);
  try { renderer = await importHost(config.sdkProvider); } catch { ctx.logger.warn('Deep PTC: SDK renderer unavailable; retaining the complete host SDK.'); }
  const compacted = failOpen(ctx, 'tool catalog', (assembly, context) => {
    const runtime = ctx.get('ptcRuntime');
    const render = runtime?.language === 'python' ? renderer.renderToolsSdkPy : runtime?.language === 'typescript' || runtime?.language === 'javascript' ? renderer.renderToolsSdk : undefined;
    if (!render || !context.scope) return assembly;
    const all = ctx.tools.definitions(context.scope, context.toolSet);
    let cached = sdkCache.get(context.scope);
    if (!cached || cached.render !== render || cached.format !== runtime.programFormat || !same(cached.all, all)) {
      cached = { all, render, format: runtime.programFormat, original: render(all.map(toolSchema), runtime.programFormat) };
      sdkCache.set(context.scope, cached);
    }
    const selected = state.sdkDefinitions(context.scope, context.toolSet, config.compact);
    if (selected.length === all.length) return assembly;
    if (!same(cached.selected, selected)) { cached.selected = selected; cached.text = render(selected.map(toolSchema), runtime.programFormat); }
    return { ...assembly, sections: assembly.sections.map(section => section.name === 'tools:sdk' && section.text === cached.original ? { ...section, text: cached.text } : section) };
  });
  if (renderer?.renderToolsSdk) ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    return compacted(assembly, context) ?? assembly;
  });
}
