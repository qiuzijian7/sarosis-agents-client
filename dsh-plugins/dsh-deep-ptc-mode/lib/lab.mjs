import z from '@deepseek-ai/schemastery';
import { fileURLToPath } from 'node:url';
import { cliCommand } from './preview.mjs';

export const name = 'deep-ptc-plugin-lab';
export const inject = ['systemPrompt'];
export const Config = z.object({});

export function apply(ctx) {
  const preview = fileURLToPath(new URL('./preview.mjs', import.meta.url));
  // The CLI of the running host version: the desktop app ships its own next to its executable.
  let cli;
  try { const found = cliCommand(undefined); cli = found.args[0] ?? found.command; } catch { cli = undefined; }
  const text = [
    'Deep creative mode is on. Inspect the relevant Cordis providers and their schemas with cordis_inspect_list and cordis_inspect_query when available.',
    'Develop in a separate checkout or staging directory. If source is linked to the active profile, copy it to a development workspace before changing it.',
    'Test in a virtual DSH: a fresh DSH with the same host version, plugins, skills and settings as the user\'s, and none of their sessions, workspaces or memory. Only one runs at a time, and every change stays inside it.',
    'Drive it with the virtual_dsh tool: start (with package: the built .tgz from npm pack), status, add_plugin and remove_plugin for extra plugins, read_config and write_config for its cordis.patch.yml, restart after a server change, logs for startup errors, chat to send it test messages and read back each turn (transcript, sessions, cancel for its conversations), stop when done. Changes restart it on the same port, so the user\'s open sidebar tab keeps working. The first change or test asks the user once for the whole conversation; after that, start and restart it as often as testing needs. Load deep-ptc-virtual-dsh-testing for the testing procedure.',
    'The user sees its progress in the Deep creative mode section of the side panel and opens it in the right sidebar from there; tell them when it is ready instead of pasting its URL.',
    `Without the tool, the same launcher runs as a managed shell job: node ${JSON.stringify(preview)} --package <absolute path to the built .tgz>${cli ? ` --cli ${JSON.stringify(cli)}` : ''} (add --no-credentials to start it signed out; host paths, and Windows node.exe with Windows paths under WSL). Its directory and copied credentials are removed when it stops, or at the next start after a hard stop.`,
    'Keep plugin installs, reloads and test runs in the virtual DSH. Apply a tested build to the active profile only when the user requests deployment. If startup fails, report the failing step.',
  ].join('\n');
  ctx.systemPrompt.section({ name: 'deep-ptc:plugin-lab', order: 10192, text });
}
