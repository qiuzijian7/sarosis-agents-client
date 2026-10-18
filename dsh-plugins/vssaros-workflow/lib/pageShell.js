// 委托层（重构 1.3）：真源已收编进 @vssaros/dsh-foundation（lib/pageShell.js）。
// 本文件只转发：插件之间不能互相 import（profile 里没有跨包解析路径），实现经 cordis 服务拿。
// 调用点签名不变；没绑到服务时抛带指引的错（见 foundationRef.js）。
import { foundation, onFoundation } from './foundationRef.js';

export function escapeHtml(value) { return foundation().escapeHtml(value); }
export function renderChips(chips) { return foundation().renderChips(chips); }
export function renderShell(opts) { return foundation().renderShell(opts); }

// SHELL_CSS 是常量字符串 ⇒ 用 live binding 回填（import 侧读时求值，页面渲染时早已填好）。
export let SHELL_CSS = '';
onFoundation(svc => { SHELL_CSS = svc.SHELL_CSS; });