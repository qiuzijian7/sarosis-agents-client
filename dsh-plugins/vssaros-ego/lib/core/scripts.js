/**
 * 要在 ego lite 的 node 上下文里跑的**脚本**与它们输出的**渲染**（全是纯函数 ⇒ 可单测）。
 *
 * ⚠ 脚本一律用**字符串数组 join** 拼，不用模板串：这些文本里到处是引号与 `$`，
 *   模板串要多一层"哪些 `$` 是我要插值、哪些是人家页面里的"心智负担（本仓已在这类地方踩过
 *   "反引号提前闭合 / 反斜杠被吃一层"两次）。数组拼接没有这种陷阱。
 */

/** 结构化输出的标记行前缀：stdout 里前面可能混着 CLI 自己的日志，只有标记行才是我们的数据。 */
export const JSON_MARK = '__VSAROS_EGO_JSON__';

/** 指南正文的上限（`ego-browser skill` 的输出一般十几 KB；超长只截断**尾部并明说**）。 */
export const GUIDE_CHAR_LIMIT = 120_000;

/**
 * `ego_status` 的探测脚本：只问"绑定在不在 / 版本 / 任务空间有几条"。
 *
 * 为什么用 try/catch 包着：探测的用途是**诊断**，不是干活 ⇒ 任何一步失败都要变成可读的一句话，
 * 而不是让整个工具调用抛错（那样模型只知道"炸了"，不知道是 app 没开还是版本太老）。
 */
export function buildProbeScript() {
	return [
		'const __out = {};',
		'try {',
		'  __out.bindings = Boolean(globalThis.ego);',
		'  if (__out.bindings) {',
		'    __out.version = typeof ego.getBrowserVersion === "function" ? await ego.getBrowserVersion() : null;',
		'    const listed = typeof ego.listTaskSpaces === "function" ? await ego.listTaskSpaces() : null;',
		'    __out.spaces = listed && Array.isArray(listed.taskSpaces)',
		'      ? listed.taskSpaces.map(s => ({ id: s.id, name: s.name, ownership: s.ownership, tabs: Array.isArray(s.recentTabTitles) ? s.recentTabTitles.length : 0 }))',
		'      : null;',
		'  }',
		'} catch (error) {',
		'  __out.error = String((error && error.message) || error);',
		'  __out.errorCode = error && error.error_code ? String(error.error_code) : null;',
		'}',
		'console.log(' + JSON.stringify(JSON_MARK) + ' + JSON.stringify(__out));',
	].join('\n');
}

/** `ego_spaces` 的脚本：列任务空间（只读，不选中、不认领）。 */
export function buildSpacesScript() {
	return [
		'const __out = {};',
		'try {',
		'  const listed = await ego.listTaskSpaces();',
		'  __out.spaces = Array.isArray(listed && listed.taskSpaces) ? listed.taskSpaces : [];',
		'} catch (error) {',
		'  __out.error = String((error && error.message) || error);',
		'  __out.errorCode = error && error.error_code ? String(error.error_code) : null;',
		'}',
		'console.log(' + JSON.stringify(JSON_MARK) + ' + JSON.stringify(__out));',
	].join('\n');
}

/**
 * 用户脚本前面要加的**预选**语句。
 *
 * `ego.useTaskSpace(id)` 只影响**本次** node 调用（上游文档：a synchronous local selection），
 * 所以必须每次调用都带上 —— 这也意味着它不会"记住"上次选的任务空间 ✓。
 */
export function buildPrelude(taskSpace) {
	if (taskSpace === undefined || taskSpace === null) { return ''; }
	return 'ego.useTaskSpace(' + String(taskSpace) + ');';
}

/** 取出标记行里的 JSON；没有标记（或解析失败）⇒ undefined（调用方按"没有结构化结果"处理）。 */
export function parseMarkedJson(stdout) {
	const text = String(stdout ?? '');
	const at = text.lastIndexOf(JSON_MARK);
	if (at < 0) { return undefined; }
	const line = text.slice(at + JSON_MARK.length).split(/\r?\n/, 1)[0];
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** 审批文案/日志里给的脚本预览（保留换行，尾部省略要说清）。 */
export function scriptPreview(script, limit = 700) {
	const text = String(script ?? '');
	if (text.length <= limit) { return text; }
	return text.slice(0, limit) + '\n…（后略，共 ' + text.length + ' 字符）';
}

/** 指南输出的归一：超长截断并**明确告知**（不要静默截断 —— 模型会以为那就是全文）。 */
export function truncateGuide(text, limit = GUIDE_CHAR_LIMIT) {
	const value = String(text ?? '');
	if (value.length <= limit) { return { text: value, truncated: false, total: value.length }; }
	return {
		text: value.slice(0, limit) + '\n\n…（指南被截断：只返回了前 ' + limit + ' 字符，共 ' + value.length + '。'
			+ '需要后段就用 ego_run 调 `help()` 或按主题查，别把这段当全文。）',
		truncated: true,
		total: value.length,
	};
}

/** CLI 找不到时的统一说明（把"试过哪些位置"如实列出来，用户才知道下一步填哪儿）。 */
export function formatMissingCli({ platform, tried }) {
	const lines = [
		'## ego lite 未就绪：找不到 `ego-browser` 命令',
		'',
		'这个插件只带**连接层**（技能 + 4 个工具），浏览器本体是 ego lite 那个独立应用 —— 它没装/没跑起来时这里无解。',
		'',
		'下一步（按顺序）：',
		'1. 安装并**打开** ego lite：https://lite.ego.app/（Windows 上必须走安装器，没有脚本；首次启动要完成 GUI onboarding）',
		'2. onboarding 完成后**重启 VsSaros**（Windows 的 PATH 只对之后启动的进程生效 —— 这是 Host 进程看不到该命令的常见原因）',
		'3. 若它装在非标准位置：在插件配置里填 `cliPath`（绝对路径，例如 `C:/Users/<你>/AppData/Local/ego lite/ego-browser.cmd`），或设环境变量 `VSSAROS_EGO_CLI`',
		'',
		'我试过这些位置（都不存在）：',
	];
	const list = Array.isArray(tried) ? tried : [];
	if (list.length === 0) {
		lines.push('- （没有可试的位置：PATH 为空？）');
	} else {
		for (const item of list.slice(0, 40)) { lines.push('- ' + item); }
		if (list.length > 40) { lines.push('- …还有 ' + (list.length - 40) + ' 个'); }
	}
	return lines.join('\n');
}

/** `ego_status` 的报告。 */
export function formatStatusReport({ platform, resolved, probe, probeError, probed }) {
	const lines = ['## ego_status'];
	lines.push('');
	lines.push('- 平台：' + platform);
	lines.push('- CLI：' + (resolved && resolved.path ? resolved.path + '（来源：' + resolved.source + '）' : '未找到'));
	if (!probe) {
		lines.push('- 运行时探测：未做（`probe: true` 会真的起一次 node 上下文，问版本与任务空间）');
		return lines.join('\n');
	}
	if (probeError) {
		lines.push('- 运行时探测：失败 —— ' + probeError);
		return lines.join('\n');
	}
	if (!probed) {
		lines.push('- 运行时探测：没有解析到结构化结果（CLI 输出里没有标记行 —— 见下面的原始输出）');
		return lines.join('\n');
	}
	lines.push('- 原生绑定：' + (probed.bindings ? '可用（globalThis.ego 在）' : '不可用（app 没运行或版本太老）'));
	if (probed.version) {
		lines.push('- 版本：' + String(probed.version.currentVersion ?? '?')
			+ (probed.version.updateAvailable === true ? '（有新版本可升级：`ego-browser upgrade`）' : ''));
	}
	if (Array.isArray(probed.spaces)) {
		lines.push('- 任务空间：' + probed.spaces.length + ' 条'
			+ (probed.spaces.length === 0 ? '' : '（' + probed.spaces.map(s => `#${s.id} ${s.name}`).join('、') + '）'));
	}
	if (probed.error) {
		lines.push('- 探测中的错误：' + probed.error + (probed.errorCode ? '（' + probed.errorCode + '）' : ''));
	}
	return lines.join('\n');
}

/** `ego_spaces` 的报告。 */
export function formatSpacesReport(payload) {
	if (!payload) {
		return '## 任务空间\n\n没有解析到结构化结果：CLI 的输出里没有标记行（它可能没跑起来，或输出被截断）。'
			+ '先用 `ego_status` 的 `probe: true` 确认绑定可用。';
	}
	if (payload.error) {
		return '## 任务空间\n\n读取失败：' + payload.error + (payload.errorCode ? '（' + payload.errorCode + '）' : '')
			+ '\n\n常见的两个原因：app 没运行（绑定不可用）、或该版本没有 `listTaskSpaces`。';
	}
	const spaces = Array.isArray(payload.spaces) ? payload.spaces : [];
	if (spaces.length === 0) {
		return '## 任务空间\n\n当前没有任务空间（0 条）。要新建：在 `ego_run` 里 `await ego.createTaskSpace("名字")`，'
			+ '或让用户在 ego lite 界面里开一个 Space 再 `claimTaskSpace`。';
	}
	const lines = ['## 任务空间（' + spaces.length + ' 条）', ''];
	for (const space of spaces) {
		const tabs = Array.isArray(space.recentTabTitles) ? space.recentTabTitles : [];
		lines.push('- #' + space.id + ' ' + space.name
			+ '｜ownership=' + (space.ownership ?? space.createdBy ?? '?')
			+ (space.profileId ? '｜profile=' + space.profileId : '')
			+ (tabs.length > 0 ? '｜最近标签：' + tabs.join(' / ') : ''));
	}
	lines.push('');
	lines.push('要用其中某一条：给 `ego_run` 传 `taskSpace: <id>`（只对那次调用生效，不会记住）。');
	lines.push('用户自己开的空间（ownership=user）要先 `ego.claimTaskSpace(id)` 才能被自动化操作。');
	return lines.join('\n');
}

/** `ego_run` 的报告：stdout 是主角，stderr / 退出码是**判据**（不要只回 stdout）。 */
export function formatRunReport({ result, taskSpace }) {
	const lines = ['## ego_run'];
	lines.push('');
	lines.push('- 退出码：' + result.code + (result.signal ? '｜信号：' + result.signal : '')
		+ (result.timedOut ? '｜**超时被杀**（脚本没有在预算内结束）' : ''));
	if (taskSpace !== undefined && taskSpace !== null) {
		lines.push('- 任务空间：# ' + taskSpace + '（本次调用内预选）');
	}
	lines.push('');
	const out = String(result.stdout ?? '').trim();
	const err = String(result.stderr ?? '').trim();
	lines.push('### stdout');
	lines.push(out.length > 0 ? out : '（空 —— 脚本没有打印任何东西；要取值就 `console.log(...)`）');
	if (err.length > 0) {
		lines.push('');
		lines.push('### stderr');
		lines.push(err);
	}
	if (result.code !== 0) {
		lines.push('');
		lines.push('⚠ 非零退出：先看 stderr 的第一行（大多是脚本自己的错，或"任务空间未选中 / 已被用户接管"）。');
	}
	return lines.join('\n');
}
