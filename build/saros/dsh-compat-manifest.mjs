#!/usr/bin/env node
// dsh 兼容清单签名工具（供 CI 的 dsh-compat 流水线使用；方案第 3.5 节）。
//
//   node build/saros/dsh-compat-manifest.mjs keygen <out-dir>
//       生成 Ed25519 密钥对：<out-dir>/dsh-compat.key（私钥，放 CI 机密，绝不入库）
//       与 <out-dir>/dsh-compat.pub（公钥，加入 src/vs/sessions/contrib/dshHarness/common/dshCompat.ts 的 DSH_COMPAT_TRUSTED_KEYS）。
//   node build/saros/dsh-compat-manifest.mjs sign <manifest.json> --key <private.pem> --key-id <id> [--out <signed.json>]
//       私钥也可经环境变量 DSH_COMPAT_SIGNING_KEY（PEM 文本）传入。
//   node build/saros/dsh-compat-manifest.mjs verify <signed.json> --pub <public.pem> --key-id <id>
//
// 信封格式与校验逻辑见 src/vs/sessions/contrib/dshHarness/electron-main/dshCompatSource.ts。
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, target, ...rest] = process.argv.slice(2);
const opt = name => {
	const i = rest.indexOf(`--${name}`);
	return i >= 0 ? rest[i + 1] : undefined;
};
const fail = msg => {
	console.error(msg);
	process.exit(1);
};

function checkManifest(m) {
	if (!m || m.schema !== 1 || typeof m.generatedAt !== 'string' || !Array.isArray(m.versions)) {
		fail('manifest must have schema=1, generatedAt, versions[]');
	}
	for (const e of m.versions) {
		if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(e?.version ?? '')) {
			fail(`invalid version entry: ${JSON.stringify(e)}`);
		}
	}
}

switch (cmd) {
	case 'keygen': {
		if (!target) {
			fail('usage: keygen <out-dir>');
		}
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'dsh-compat.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
		writeFileSync(join(target, 'dsh-compat.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
		console.log(`wrote ${join(target, 'dsh-compat.key')} (secret) and ${join(target, 'dsh-compat.pub')}`);
		break;
	}
	case 'sign': {
		const keyId = opt('key-id');
		const keyPem = process.env.DSH_COMPAT_SIGNING_KEY || (opt('key') && readFileSync(opt('key'), 'utf8'));
		if (!target || !keyId || !keyPem) {
			fail('usage: sign <manifest.json> --key <private.pem>|$DSH_COMPAT_SIGNING_KEY --key-id <id> [--out <file>]');
		}
		const text = readFileSync(target, 'utf8');
		checkManifest(JSON.parse(text));
		const payload = Buffer.from(text, 'utf8');
		const signature = sign(null, payload, createPrivateKey(keyPem));
		const envelope = JSON.stringify({ keyId, payload: payload.toString('base64'), signature: signature.toString('base64') }, undefined, 2) + '\n';
		if (opt('out')) {
			writeFileSync(opt('out'), envelope);
		} else {
			process.stdout.write(envelope);
		}
		break;
	}
	case 'verify': {
		const keyId = opt('key-id');
		const pub = opt('pub');
		if (!target || !keyId || !pub) {
			fail('usage: verify <signed.json> --pub <public.pem> --key-id <id>');
		}
		const env = JSON.parse(readFileSync(target, 'utf8'));
		if (env.keyId !== keyId) {
			fail(`keyId mismatch: ${env.keyId} != ${keyId}`);
		}
		const payload = Buffer.from(env.payload, 'base64');
		if (!verify(null, payload, createPublicKey(readFileSync(pub, 'utf8')), Buffer.from(env.signature, 'base64'))) {
			fail('signature INVALID');
		}
		checkManifest(JSON.parse(payload.toString('utf8')));
		console.log('signature OK');
		break;
	}
	default:
		fail('commands: keygen | sign | verify');
}
