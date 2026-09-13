// 一次性脚本：把 agentMemoryProviderProxy.ts 内剩余 console.* 改为注入 logger
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agentMemoryProviderProxy.ts');
let t = readFileSync(p, 'utf8');
const before = (t.match(/console\.(log|warn|error|debug)\(/g) ?? []).length;
t = t.replace(/console\.log\(/g, 'this._log.info?.(');
t = t.replace(/console\.warn\(/g, 'this._log.warn?.(');
t = t.replace(/console\.error\(/g, 'this._log.error?.(');
t = t.replace(/console\.debug\(/g, 'this._log.debug?.(');
writeFileSync(p, t, 'utf8');
const after = (t.match(/console\.(log|warn|error|debug)\(/g) ?? []).length;
console.log(`console calls: ${before} -> ${after}`);
