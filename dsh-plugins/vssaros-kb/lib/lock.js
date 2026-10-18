// 委托层（重构 1.3）：真源已收编进 @vssaros/dsh-foundation（lib/lock.js）。
// 协议 v2 的注释与文档见真源；本文件只转发（插件之间不能互相 import，实现经 cordis 服务拿）。
import { foundation, onFoundation } from './foundationRef.js';

export function lockFileFor(target) { return foundation().lockFileFor(target); }
export function isPidAlive(pid) { return foundation().isPidAlive(pid); }
export function acquireFileLock(lock, options) { return foundation().acquireFileLock(lock, options); }
export function atomicWriteFile(file, text, options) { return foundation().atomicWriteFile(file, text, options); }

// 协议常量 ⇒ live binding 回填（读时求值，调用时都发生在服务绑定之后）。
export let FILE_LOCK_SUFFIX = '.lock';
export let FILE_LOCK_WAIT_MS = 5000;
export let FILE_LOCK_STALE_MS = 15000;
export let FILE_LOCK_POLL_MS = 100;
export let FILE_LOCK_HEARTBEAT_MS = 2000;
export let ATOMIC_TMP_POSTFIX = '.vssaros-tmp';
onFoundation(svc => {
	FILE_LOCK_SUFFIX = svc.FILE_LOCK_SUFFIX;
	FILE_LOCK_WAIT_MS = svc.FILE_LOCK_WAIT_MS;
	FILE_LOCK_STALE_MS = svc.FILE_LOCK_STALE_MS;
	FILE_LOCK_POLL_MS = svc.FILE_LOCK_POLL_MS;
	FILE_LOCK_HEARTBEAT_MS = svc.FILE_LOCK_HEARTBEAT_MS;
	ATOMIC_TMP_POSTFIX = svc.ATOMIC_TMP_POSTFIX;
});