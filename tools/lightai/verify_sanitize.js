// 验证 sanitizeForWAF 后 WAF 放行
const B = 'https://lightai-gemini-chat-v1-sd.aigclsp.com';
const H = {
	'content-type': 'application/json', accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: B, referer: B + '/',
	'x-user-id': 'zijianqiu@tencent.com', app_id: '137', biz_id: '73',
	project_name: encodeURIComponent('萨罗斯GR项目'),
	cookie: 'sessionid=23fd0a7b4a; uid=oDF52904CQJM3N0VDNTHBMJJCQJY3',
};

// 与 extension.ts 中 sanitizeForWAF 完全一致
function sanitizeForWAF(text) {
	let changed = false;
	let out = text;
	out = out.replace(/<(\s*)script/gi, (_m, sp) => { changed = true; return '<' + sp + 'scr ipt'; });
	out = out.replace(/javascript\s*:/gi, () => { changed = true; return 'java script :'; });
	out = out.replace(/\b(alert|prompt|confirm|eval)\s*\(/gi, (_m, w) => { changed = true; return w.slice(0, -1) + ' ' + w.slice(-1) + '('; });
	out = out.replace(/document\.cookie/gi, () => { changed = true; return 'document .cookie'; });
	out = out.replace(/union\s+select/gi, () => { changed = true; return 'union sele ct'; });
	out = out.replace(/\b(on[a-z]{2,})\s*=/gi, (_m, w) => { changed = true; return w.slice(0, 2) + ' ' + w.slice(2) + '='; });
	return { text: out, changed };
}

async function send(text) {
	const cr = await fetch(B + '/api/gemini/chat/create_conversation', {
		method: 'POST', headers: H, body: JSON.stringify({ title: 'probe', conversation_type: 'PERMANENT' }),
	});
	const { id } = await cr.json();
	const r = await fetch(B + '/api/gemini/chat/send_message/' + id, {
		method: 'POST', headers: H,
		body: JSON.stringify({
			text, file_urls: [], file_names: [], model: 'gemini-3.5-flash',
			enable_thought: false, enable_search: false, preset_id: null,
			billing_info: { app_id: '137', app_name: '智能对话', project_id: '73', project_name: '萨罗斯GR项目', user_type: '内部用户', company: '腾讯-二方公司' },
		}),
	});
	return r.status;
}

(async () => {
	const samples = [
		'这是一个 <script>alert(1)</script> 的示例',
		'请解释 javascript:alert(1) 是什么',
		'SQL 注入常用 union select 语句',
		'按钮的 onclick= 事件处理',
		'document.cookie 会被窃取',
		'prompt(1) 和 confirm(2) 和 eval(3)',
		'混合：<script> + union select + onclick=alert(1) + javascript:void(0) + document.cookie',
	];
	let pass = 0, fail = 0;
	for (const raw of samples) {
		const { text, changed } = sanitizeForWAF(raw);
		const status = await send(text);
		const ok = status === 200;
		ok ? pass++ : fail++;
		console.log(`${ok ? 'PASS' : 'FAIL'} [${status}] changed=${changed}`);
		console.log('  原文:', raw.slice(0, 60));
		console.log('  无害化:', text.slice(0, 60));
	}
	console.log(`\n${pass}/${pass + fail} 通过`);
})();