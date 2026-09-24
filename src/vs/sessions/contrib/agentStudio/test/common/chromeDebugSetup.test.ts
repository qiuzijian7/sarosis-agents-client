/*---------------------------------------------------------------------------------------------
 *  Chrome 调试设置页「自动打开」的纯逻辑单测。
 *
 *  这些断言防的不是"写错一个字符串"，而是两个会让功能**静默失效**的情形：
 *   ① 锚点被"顺手清理"（`#remote-debugging` 掉了 → 打开的是没有那个勾选框的页面，
 *      用户按提示找遍页面也找不到，比不打开更糟）；
 *   ② 候选路径里混进 `undefined`（env 缺失时模板拼接的经典坑 → existsSync 永远 false
 *      → 报"找不到 Chrome"，而机器上明明装着）。
 *
 *  运行：npm run test-agentstudio-common
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	CHROME_PATH_ENV,
	CHROME_REMOTE_DEBUGGING_PAGE,
	OWN_CHROME_CHOICE_CANCEL,
	OWN_CHROME_CHOICE_KEEP_DEDICATED,
	OWN_CHROME_CHOICE_RECHECK,
	buildDedicatedChromeArgs,
	chromeExecutableCandidates,
	dedicatedProfileDir,
	interpretOwnChromeChoice,
	ownChromeGuideQuestion,
	ownChromeOutcomeText,
	pickChromeExecutable,
	remoteDebuggingHint,
} from '../../common/chromeDebugSetup.js';

const WIN_CHROME_REL = String.raw`\Google\Chrome\Application\chrome.exe`;

suite('chromeDebugSetup — Chrome 调试设置页的定位与打开', () => {

	test('★ 页面地址必须是带 #remote-debugging 的那一页（用户要照着手输，错了就找不到勾选框）', () => {
		// 这个常量不是"给代码用的参数"，而是要**显示给用户让他手敲**的地址：
		// Chrome 忽略从命令行传来的 chrome:// URL（四种写法实测全部只开出空白 New Tab），
		// 所以提示文案里那个字符串必须逐字正确 —— 去掉 fragment 会落到默认分区，
		// 用户照着输入却看不到勾选框，比不给提示更糟。
		assert.strictEqual(CHROME_REMOTE_DEBUGGING_PAGE, 'chrome://inspect/#remote-debugging');
	});

	test('Windows：候选按 用户覆盖 → 系统级 → 用户级 → 非默认盘 排序', () => {
		const candidates = chromeExecutableCandidates({
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
		}, 'win32');

		assert.strictEqual(candidates[0], `C:\\Program Files${WIN_CHROME_REL}`, '系统级安装优先');
		assert.ok(candidates.includes(`C:\\Program Files (x86)${WIN_CHROME_REL}`), '32 位程序目录');
		assert.ok(candidates.includes(`C:\\Users\\me\\AppData\\Local${WIN_CHROME_REL}`), '用户级安装（无管理员权限时落这里）');
		assert.ok(candidates.includes(`D:\\Program Files${WIN_CHROME_REL}`), '非默认盘兜底（企业环境常见）');
	});

	test('★ env 缺字段时不得产出含 "undefined" 的路径', () => {
		// 若实现写成 `${env['LOCALAPPDATA']}\...` 而不判空，这里就会得到
		// "undefined\Google\...\chrome.exe" —— existsSync 恒 false，报错却指向一个不存在的路径。
		const candidates = chromeExecutableCandidates({}, 'win32');
		assert.ok(candidates.length > 0, '至少要有默认兜底');
		for (const p of candidates) {
			assert.ok(!p.includes('undefined'), `候选路径含 undefined：${p}`);
			assert.ok(p.endsWith('chrome.exe'), `候选路径不像 chrome.exe：${p}`);
		}
	});

	test('★ SAROS_CHROME_PATH 覆盖项排在最前（逃生舱要先于猜测生效）', () => {
		const override = 'D:\\Tools\\chrome\\chrome.exe';
		const candidates = chromeExecutableCandidates({
			[CHROME_PATH_ENV]: override,
			ProgramFiles: 'C:\\Program Files',
		}, 'win32');
		assert.strictEqual(candidates[0], override);
	});

	test('覆盖项与标准路径相同时只保留一份（去重）', () => {
		const standard = `C:\\Program Files${WIN_CHROME_REL}`;
		const withOverride = chromeExecutableCandidates({ [CHROME_PATH_ENV]: standard, ProgramFiles: 'C:\\Program Files' }, 'win32');
		const withoutOverride = chromeExecutableCandidates({ ProgramFiles: 'C:\\Program Files' }, 'win32');
		assert.strictEqual(withOverride.length, withoutOverride.length);
		assert.strictEqual(withOverride.filter(p => p === standard).length, 1);
	});

	test('覆盖项为空串/空白时视为未设置（不产生空候选）', () => {
		const candidates = chromeExecutableCandidates({ [CHROME_PATH_ENV]: '   ', ProgramFiles: 'C:\\Program Files' }, 'win32');
		assert.ok(candidates.every(p => p.trim().length > 0));
		assert.strictEqual(candidates[0], `C:\\Program Files${WIN_CHROME_REL}`);
	});

	test('macOS / Linux 各自的常见安装位置', () => {
		assert.deepStrictEqual(
			chromeExecutableCandidates({}, 'darwin'),
			['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
		);
		const linux = chromeExecutableCandidates({}, 'linux');
		assert.ok(linux.includes('/usr/bin/google-chrome'));
		assert.ok(linux.includes('/usr/bin/google-chrome-stable'));
	});

	test('pickChromeExecutable：取第一个存在的；都不存在返回 undefined', () => {
		const candidates = ['a', 'b', 'c'];
		assert.strictEqual(pickChromeExecutable(candidates, p => p === 'b'), 'b');
		assert.strictEqual(pickChromeExecutable(candidates, p => p === 'c'), 'c', '不看顺序只看存在性');
		assert.strictEqual(pickChromeExecutable(candidates, () => false), undefined);
		assert.strictEqual(pickChromeExecutable([], () => true), undefined, '空候选不该抛错');
	});

	test('pickChromeExecutable 按候选顺序取第一个（不因先命中后面的而跳级）', () => {
		const seen: string[] = [];
		const picked = pickChromeExecutable(['a', 'b', 'c'], p => { seen.push(p); return true; });
		assert.strictEqual(picked, 'a');
		assert.deepStrictEqual(seen, ['a'], '命中后不应继续检查（避免无谓的 existsSync）');
	});

	// ─── Route B：自行拉起"可调试实例"的参数 ─────────────────────────────

	test('专属 profile 落在 ~/.vssaros 下（两种路径分隔符各自正确）', () => {
		assert.strictEqual(dedicatedProfileDir('C:\\Users\\me', 'win32'), 'C:\\Users\\me\\.vssaros\\browser-profile');
		assert.strictEqual(dedicatedProfileDir('/Users/me', 'darwin'), '/Users/me/.vssaros/browser-profile');
		assert.strictEqual(dedicatedProfileDir('/home/me', 'linux'), '/home/me/.vssaros/browser-profile');
	});

	test('★★ 拉起参数必须带 --user-data-dir（缺了它整个 Route B 都是无效的）', () => {
		// Chrome 136+ 对**默认** profile 静默忽略 --remote-debugging-port；
		// 带上独立的 --user-data-dir 才会真的开端口 —— 这正是"无需用户勾同意框"的全部原理。
		const args = buildDedicatedChromeArgs('C:\\p', 9222, false);
		assert.ok(args.includes('--user-data-dir=C:\\p'),
			'缺 --user-data-dir ⇒ 端口不会开，Route B 静默失效（最坏的那种失败）');
		assert.ok(args.includes('--remote-debugging-port=9222'));
		assert.ok(args.includes('--no-first-run'), '新 profile 首启会弹欢迎/导入向导，挡住页面并让端口就绪时间不可预测');
		assert.ok(args.includes('--no-default-browser-check'));
	});

	test('端口用调用方给的值（不硬编码 9222 —— 用户可能改过端口）', () => {
		assert.ok(buildDedicatedChromeArgs('C:\\p', 4567, false).includes('--remote-debugging-port=4567'));
	});

	test('无头开关：只在 true 时加 --headless，且用不带 =new 的写法', () => {
		assert.ok(!buildDedicatedChromeArgs('C:\\p', 9222, false).some(a => a.startsWith('--headless')),
			'默认必须有窗口 —— 首次登录要在窗口里做，无头会把人挡在外面');
		const headlessArgs = buildDedicatedChromeArgs('C:\\p', 9222, true);
		assert.ok(headlessArgs.includes('--headless'));
		assert.ok(!headlessArgs.includes('--headless=new'),
			'用不带 =new 的 --headless：Chrome 132+ 起它就是新无头，而老版本不认 =new 反而会落到有窗口模式');
		assert.ok(headlessArgs.includes('--user-data-dir=C:\\p'),
			'无头模式也必须带 --user-data-dir（与是否无头无关的硬要求）');
	});

});

// ─── 探测失败时给用户看的引导文案 ─────────────────────────────────────────────

suite('chromeDebugSetup — 探测失败的引导文案', () => {

	test('★★ 必须同时点名"你设置的端口"和"专属实例的端口"（两个数不同，混了会让人改错地方）', () => {
		const text = remoteDebuggingHint({ configuredPort: 9222, dedicatedPort: 9223, detail: 'ECONNREFUSED' });
		assert.ok(text.includes('9222'), '配置端口 —— 用户能在设置里改的那个');
		assert.ok(text.includes('9223'), '专属实例实际所在 —— "什么都不用做"那条路的落点');
		assert.ok(text.includes(CHROME_REMOTE_DEBUGGING_PAGE), '要照着手输的页面地址（写错会找不到勾选框）');
	});

	test('★ 底层错误原样带在最前（不要把真实原因吞掉）', () => {
		const detail = 'CDP 端点探测失败（http://127.0.0.1:9222）：ECONNREFUSED';
		assert.ok(remoteDebuggingHint({ configuredPort: 9222, dedicatedPort: 9223, detail }).startsWith(detail));
	});

	test('★★ 必须说清"那个开关没有端口选项、只认 9222"', () => {
		// 这条约束一旦从文案里消失，用户就会以为"勾了同意框 + 把端口改成 9333"能配套使用，
		// 改完却连不上，于是又回到"它说我没登录"。所以钉住它（措辞可变，9222 必须还在）。
		const text = remoteDebuggingHint({ configuredPort: 9333, dedicatedPort: 9334, detail: 'x' });
		assert.ok(text.includes('没有端口选项'), '要显式说明那个开关没有端口选项');
		assert.ok(text.includes('9222'), '必须点名 9222：那是那个开关唯一会用的端口');
	});

	test('★ 文案里的端口随设置变化（不能写死 9222）', () => {
		const text = remoteDebuggingHint({ configuredPort: 9333, dedicatedPort: 9334, detail: 'x' });
		assert.ok(text.includes('9333') && text.includes('9334'));
		assert.ok(text.includes('--remote-debugging-port=9333'), '手动起实例那条路要用配置端口');
	});

});

// ─── 「改用你自己日常的 Chrome」引导卡（2026-09-24）────────────────────────────

suite('chromeDebugSetup — 改用你自己 Chrome 的引导卡', () => {

	test('★★ 按钮文案反解：三个选项各自映射正确，未知值一律 cancel（绝不误触发连接动作）', () => {
		// 卡片选项是**按文案字符串**回传的（clarify 协议：options 即按钮）⇒ 文案与判据必须是
		// 同一份字面量。改文案忘了改判据的表现是"点了没反应"，最难归因 —— 所以逐个钉住。
		assert.strictEqual(interpretOwnChromeChoice(OWN_CHROME_CHOICE_RECHECK), 'recheck');
		assert.strictEqual(interpretOwnChromeChoice(OWN_CHROME_CHOICE_KEEP_DEDICATED), 'keep-dedicated');
		assert.strictEqual(interpretOwnChromeChoice(OWN_CHROME_CHOICE_CANCEL), 'cancel');
		for (const bad of [undefined, '', '   ', '我已勾选', 'recheck', '确认']) {
			assert.strictEqual(interpretOwnChromeChoice(bad), 'cancel',
				`未知值 ${JSON.stringify(bad)} 必须按取消处理（猜错会去改用户的浏览器连接）`);
		}
	});

	test('★★ 引导正文必须点明"手输那个地址"与"没法替你完成"', () => {
		const q = ownChromeGuideQuestion({ configuredPort: 9222 });
		assert.ok(q.includes(CHROME_REMOTE_DEBUGGING_PAGE), '要给出照着手输的页面地址');
		assert.ok(q.includes('手输'), '必须写明手输：Chrome 会忽略程序传来的 chrome:// 地址');
		assert.ok(q.includes('没法替你完成'), '必须说清这一步只能用户做（否则他会等我们自动完成）');
		assert.ok(q.includes('9222'), '要点名端口 —— 那个勾选框没有端口选项');
		assert.ok(q.includes('重启'), '要提醒勾选只对当次实例有效（重启 Chrome 要重勾）');
	});

	test('★ 结论文案：连上了要说清"带你全部登录态"；没连上要给出两条端口线索', () => {
		const ok = ownChromeOutcomeText(
			{ kind: 'connected', endpoint: 'http://127.0.0.1:9222' },
			{ configuredPort: 9222, dedicatedPort: 9223 },
		);
		assert.ok(ok.includes('http://127.0.0.1:9222') && ok.includes('登录态'));

		const bad = ownChromeOutcomeText(
			{ kind: 'not-found', detail: '这次连上的是专属实例（http://127.0.0.1:9223）' },
			{ configuredPort: 9222, dedicatedPort: 9223 },
		);
		assert.ok(bad.includes('9222') && bad.includes('9223'), '两个端口都要报（他该改哪个 / 实际连到了哪个）');
		assert.ok(bad.includes('重启'), '要包含"勾选后重启过 Chrome"这条最常见原因');

		const keep = ownChromeOutcomeText({ kind: 'keep-dedicated' }, { configuredPort: 9222, dedicatedPort: 9223 });
		assert.ok(keep.includes('空 profile') && keep.includes('9223'), '继续用专属实例必须说清代价');
	});

});
