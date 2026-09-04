/* 验证：从 lightflood 前端 bundle 解析三类生成模型清单（复刻 modelDiscovery.ts 逻辑） */
const FLOOD = 'https://lightai-lightflood-v1-sd.aigclsp.com';
const COOKIE = process.env.LIGHTAI_COOKIE || '';

const headers = () => ({
	accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: FLOOD,
	referer: `${FLOOD}/flow`,
	cookie: COOKIE,
});

(async () => {
	const htmlResp = await fetch(`${FLOOD}/`, { headers: { ...headers(), accept: 'text/html' } });
	const html = await htmlResp.text();
	const entryUrls = [...new Set([...html.matchAll(/src="(\/[^"]+\.js)"/g)].map(m => m[1]))];
	console.log('[1] entry JS:', entryUrls.length);

	const CHUNK_RE = /"((?:\.\/)?assets\/[A-Za-z0-9_-]+\.js)"/g;
	const fetched = new Map();
	let frontier = [...entryUrls];
	for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
		const next = [];
		for (const u of frontier) {
			if (fetched.has(u) || fetched.size > 80) continue;
			try {
				const r = await fetch(`${FLOOD}${u}`, { headers: headers() });
				if (!r.ok) continue;
				const js = await r.text();
				fetched.set(u, js);
				for (const c of js.matchAll(CHUNK_RE)) {
					const raw = c[1].replace(/^\.\//, '');
					const path = raw.startsWith('/') ? raw : `/${raw}`;
					if (!fetched.has(path) && !next.includes(path)) next.push(path);
				}
			} catch { continue; }
		}
		frontier = next;
	}
	console.log('[2] fetched chunks:', fetched.size);

	const MODEL_RE = /value:\s*"((?:picture|video|model)_[A-Za-z0-9_]+)"/g;
	const NAME_RE = /name:\s*"([^"]{1,60})"/g;
	const order = [], names = {}, seen = new Set();
	for (const js of fetched.values()) {
		MODEL_RE.lastIndex = 0;
		let m;
		while ((m = MODEL_RE.exec(js))) {
			const id = m[1];
			if (seen.has(id)) continue;
			seen.add(id);
			order.push(id);
			const lookback = js.slice(Math.max(0, m.index - 800), m.index);
			NAME_RE.lastIndex = 0;
			let nm, last = '';
			while ((nm = NAME_RE.exec(lookback))) last = nm[1];
			if (last) names[id] = last;
		}
	}

	const image = order.filter(id => id.startsWith('picture_'));
	const video = order.filter(id => id.startsWith('video_'));
	const model3d = order.filter(id => id.startsWith('model_'));
	console.log(`[2] 发现：图片 ${image.length} / 视频 ${video.length} / 3D ${model3d.length}`);
	console.log('\n图片:', JSON.stringify(image, null, 0));
	console.log('  名称:', image.map(id => `${id}=${names[id] || '?'}`).join(' | '));
	console.log('\n视频:', JSON.stringify(video, null, 0));
	console.log('  名称:', video.map(id => `${id}=${names[id] || '?'}`).join(' | '));
	console.log('\n3D:', JSON.stringify(model3d, null, 0));
	console.log('  名称:', model3d.map(id => `${id}=${names[id] || '?'}`).join(' | '));
})().catch(e => { console.error('EXCEPTION:', e.message); process.exit(1); });
