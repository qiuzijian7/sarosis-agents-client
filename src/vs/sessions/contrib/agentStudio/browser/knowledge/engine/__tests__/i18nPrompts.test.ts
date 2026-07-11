/*---------------------------------------------------------------------------------------------
 *  i18n prompt catalog tests.
 *
 *  - `getPrompt` / `resolveLocale` / `setLocale` behave for both locales.
 *  - `prompts.yaml` is the editable mirror of the catalog; we regenerate it
 *    from the in-code catalog and assert the committed file matches exactly
 *    (drift → fail). Because the serializer emits valid YAML, a match also
 *    guarantees the file is well-formed & in sync.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
	PROMPT_CATALOG,
	PROMPT_RAW,
	promptKeys,
	hasPrompt,
	getPrompt,
	getLocale,
	resolveLocale,
	setLocale,
	DEFAULT_LOCALE,
	type BiPrompt,
} from '../i18nPrompts.js';

const engineDir = process.env.KB_ENGINE_DIR!;
const yamlPath = path.join(engineDir, 'prompts.yaml');

/** Mirror of gen-prompts-yaml.mjs serializer (deterministic). */
function toYaml(obj: Record<string, unknown>, indent = 0): string {
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
			out += `${pad}${k}:\n` + toYaml(v as Record<string, unknown>, indent + 1);
		}
	}
	return out;
}

/** Normalize a YAML string for drift comparison (ignore trailing whitespace / blank lines). */
function normalize(yaml: string): string {
	return yaml
		.split('\n')
		.map(l => l.replace(/\s+$/, ''))
		.filter((l, i, arr) => !(l === '' && arr[i + 1] === '' && i === arr.length - 1))
		.join('\n')
		.replace(/\n+$/, '');
}

test('catalog exposes every locale pair (en + zh) for all 60 keys', () => {
	const keys = promptKeys();
	assert.ok(keys.length >= 60, `expected >=60 keys, got ${keys.length}`);
	for (const k of keys) {
		const p = PROMPT_CATALOG[k] as BiPrompt;
		assert.ok(p && typeof p.en === 'string' && p.en.length > 0, `${k}.en missing/empty`);
		assert.ok(p && typeof p.zh === 'string' && p.zh.length > 0, `${k}.zh missing/empty`);
	}
});

test('resolveLocale normalizes VS Code env.language', () => {
	assert.strictEqual(resolveLocale('zh-CN'), 'zh');
	assert.strictEqual(resolveLocale('zh-TW'), 'zh');
	assert.strictEqual(resolveLocale('en'), 'en');
	assert.strictEqual(resolveLocale('en-US'), 'en');
	assert.strictEqual(resolveLocale('fr'), DEFAULT_LOCALE);
	assert.strictEqual(resolveLocale(undefined), DEFAULT_LOCALE);
	assert.strictEqual(resolveLocale(null), DEFAULT_LOCALE);
});

test('getPrompt honors explicit locale and active locale', () => {
	const k = 'template.faq';
	assert.strictEqual(getPrompt(k, 'en'), PROMPT_CATALOG[k].en);
	assert.strictEqual(getPrompt(k, 'zh'), PROMPT_CATALOG[k].zh);

	setLocale('en');
	assert.strictEqual(getLocale(), 'en');
	assert.strictEqual(getPrompt(k), PROMPT_CATALOG[k].en);

	setLocale('zh-CN');
	assert.strictEqual(getLocale(), 'zh');
	assert.strictEqual(getPrompt(k), PROMPT_CATALOG[k].zh);
});

test('hasPrompt / unknown key throws', () => {
	assert.strictEqual(hasPrompt('method.graph_rag.community'), true);
	assert.strictEqual(hasPrompt('nope.nope'), false);
	assert.throws(() => getPrompt('does.not.exist'));
});

test('prompts.yaml is in sync with the catalog (no drift)', () => {
	const committed = readFileSync(yamlPath, 'utf8');
	const expected = toYaml(PROMPT_RAW);
	assert.strictEqual(
		normalize(committed),
		normalize(expected),
		'prompts.yaml drifted from the catalog — re-run gen-prompts-yaml.mjs',
	);
});

test('prompts.yaml carries both en/zh leaves for every key', () => {
	const committed = readFileSync(yamlPath, 'utf8');
	const enCount = (committed.match(/^\s*en:\s*\|/gm) ?? []).length;
	const zhCount = (committed.match(/^\s*zh:\s*\|/gm) ?? []).length;
	assert.strictEqual(enCount, promptKeys().length, 'en leaf count mismatch');
	assert.strictEqual(zhCount, promptKeys().length, 'zh leaf count mismatch');
});
