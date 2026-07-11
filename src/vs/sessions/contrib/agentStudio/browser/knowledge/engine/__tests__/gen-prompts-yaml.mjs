// Generates `prompts.yaml` from the i18n prompt catalog (i18nPrompts.ts).
// Single source of truth = the TS catalog; this keeps the editable YAML mirror
// in perfect sync. Re-run after editing the catalog.
//
//   node engine/__tests__/gen-prompts-yaml.mjs

import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = join(here, '..');
const outFile = join(engineDir, 'prompts.yaml');
const tmp = join(here, '.prompts-gen.mjs');

/** Serialize the nested catalog to a YAML file (leaf strings → literal blocks). */
function toYaml(obj, indent = 0) {
	let out = '';
	for (const [k, v] of Object.entries(obj)) {
		const pad = '  '.repeat(indent);
		if (typeof v === 'string') {
			if (v.includes('\n')) {
				out += `${pad}${k}: |\n`;
				for (const line of v.split('\n')) {
					out += `${pad}  ${line}\n`;
				}
			} else {
				out += `${pad}${k}: ${JSON.stringify(v)}\n`;
			}
		} else {
			out += `${pad}${k}:\n` + toYaml(v, indent + 1);
		}
	}
	return out;
}

const res = await build({
	entryPoints: [join(engineDir, 'i18nPrompts.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	write: false,
});
writeFileSync(tmp, res.outputFiles[0].text);

const mod = await import(`file://${tmp}`);
const yaml = toYaml(mod.PROMPT_RAW);
writeFileSync(outFile, yaml);
rmSync(tmp, { force: true });

const keys = mod.promptKeys();
console.log(`Wrote ${outFile} (${keys.length} prompt keys).`);
