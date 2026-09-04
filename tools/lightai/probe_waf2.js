// 精确摸清 WAF 规则边界
const B = 'https://lightai-gemini-chat-v1-sd.aigclsp.com';
const H = {
	'content-type': 'application/json', accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: B, referer: B + '/',
	'x-user-id': 'zijianqiu@tencent.com', app_id: '137', biz_id: '73',
	project_name: encodeURIComponent('萨罗斯GR项目'),
	cookie: 'sessionid=23fd0a7b4a; uid=oDF52904CQJM3N0VDNTHBMJJCQJY3',
};

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
		'<script>', '</script>', '< script>', '<scr ipt>',
		'<div>', '<iframe>', '<svg>', '<img>', 'javascript:alert(1)',
		'or 1=1', 'or 1 = 1', "or '1'='1", 'union select', '--', "'; drop table",
		'select * from users where id=1',
		'<html><body>hello</body></html>',
		'onclick=', 'onerror=',
	];
	for (const s of samples) {
		console.log((s.length < 24 ? s.padEnd(24) : s.slice(0, 24)).padEnd(24), '->', await send('测试内容: ' + s));
	}
})();