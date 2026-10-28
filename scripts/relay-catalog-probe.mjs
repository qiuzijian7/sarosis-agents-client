import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = 'g:/SarosWorkspace/sarosis-agents-client/dsh-plugins/vssaros-relay';
const mod = await import(pathToFileURL(path.join(PKG, 'lib', 'codebuddy.js')).href);

const cred = fs.readFileSync(process.env.USERPROFILE + '/.vssaros-dev/dsh-home/.credentials.yaml', 'utf8');
const tok = /VSSAROS_CODEBUDDY_KEY:\s*'?([A-Za-z0-9_\-.]+)'?/.exec(cred)?.[1] ?? '';
console.log('token len =', tok.length);
console.log('identity =', JSON.stringify(mod.identityOf(tok)));

const res = await mod.listModels(tok, { endpoint: mod.CODEBUDDY_DEFAULT_ENDPOINT });
console.log('ok =', res.ok, ' error =', res.error, ' message =', res.message);
console.log('models =', Array.isArray(res.models) ? res.models.length : res.models);

const raw = await fetch('https://copilot.tencent.com/v3/config', {
	headers: { ...mod.identityHeaders(tok), Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
});
const text = await raw.text();
console.log('--- 平台原始响应前 300 字 ---');
console.log(text.slice(0, 300));
