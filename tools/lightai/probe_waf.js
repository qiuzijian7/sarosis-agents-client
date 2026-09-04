// 定位 501 WAF 拦截的触发条件：body 大小 vs 特殊字符
const B = 'https://lightai-gemini-chat-v1-sd.aigclsp.com';
const H = {
	'content-type': 'application/json', accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: B, referer: B + '/',
	'x-user-id': 'zijianqiu@tencent.com', app_id: '137', biz_id: '73',
	project_name: encodeURIComponent('萨罗斯GR项目'),
	cookie: 'sessionid=23fd0a7b4a; uid=oDF52904CQJM3N0VDNTHBMJJCQJY3',
};

async function send(model, text) {
	const cr = await fetch(B + '/api/gemini/chat/create_conversation', {
		method: 'POST', headers: H,
		body: JSON.stringify({ title: 'probe', conversation_type: 'PERMANENT' }),
	});
	const { id } = await cr.json();
	const r = await fetch(B + '/api/gemini/chat/send_message/' + id, {
		method: 'POST', headers: H,
		body: JSON.stringify({
			text, file_urls: [], file_names: [], model,
			enable_thought: false, enable_search: false, preset_id: null,
			billing_info: {
				app_id: '137', app_name: '智能对话', project_id: '73',
				project_name: '萨罗斯GR项目', user_type: '内部用户', company: '腾讯-二方公司',
			},
		}),
	});
	const raw = await r.text();
	return `${r.status} len=${raw.length} ${raw.slice(0, 60).replace(/\s+/g, ' ')}`;
}

(async () => {
	const tests = [
		['小文本(20字)', 'x'.repeat(20)],
		['中文本(5千)', 'x'.repeat(5000)],
		['大文本(5万)', 'x'.repeat(50000)],
		['大文本(10万)', 'x'.repeat(100000)],
		['含<script>', 'hello <script>alert(1)</script>'],
		['含SQL', "select * from users where id='1' or 1=1 --"],
		['含JSON工具定义', 'tools: [{"type":"function","function":{"name":"x","parameters":{"type":"object","properties":{"a":{"type":"string"}}}}}]'.repeat(50)],
	];
	for (const [name, text] of tests) {
		console.log(name.padEnd(14), '->', await send('gemini-3.5-flash', text));
	}
})();