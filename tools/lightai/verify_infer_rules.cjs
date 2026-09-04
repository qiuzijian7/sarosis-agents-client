/* 验证 infer*Gen 前缀规则：对 44 个编排域模型全命中 + 聊天模型不误伤 */
const FLOOD = 'https://lightai-lightflood-v1-sd.aigclsp.com';

function inferVideoGen(m) {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(text[- ]to[- ]video|image[- ]to[- ]video|video[- ]generation|video[- ]gen|generate[ -]videos|text2video|i2v|t2v)/.test(hay)) return true;
	if (/(^|[^a-z])video_[a-z0-9_]+/.test(hay)) return true;
	return /(^|[^a-z])(kling|keling|seedance|wanx?[- _]?[0-9]|hunyuan[- _]video|minimax[- _]video|video_gen|sora|veo|runway|gen-?3|luma|pika|hailuo)([^a-z]|$)/.test(hay);
}
function inferModelGen(m) {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(image[- ]to[- ]3d|text[- ]to[- ]3d|3d[- ]generation|3d[- ]gen|generate[ -]3d|model[- ]gen)/.test(hay)) return true;
	if (/(^|[^a-z])model_[a-z0-9_]+/.test(hay)) return true;
	return /(^|[^a-z])(tripo|rodin|hunyuan[- _]?3d|meshy|luma[- _]?ai|3d[_ -]model|instant[- _]?mesh|csm)([^a-z]|$)/.test(hay);
}
function inferAudioGen(m) {
	const hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(text[- ]to[- ]audio|audio[- ]generation|audio[- ]gen|generate[ -]audio|t2a|tts\b|speech[- ]synth)/.test(hay)) return true;
	if (/(^|[^a-z])audio_[a-z0-9_]+/.test(hay)) return true;
	return /(^|[^a-z])(speech[- _]?[0-9]|minimax[- _]?speech|seed[- _]?audio|suno|cosyvoice|fish[- _]?speech|gpt[- _]?sovits)([^a-z]|$)/.test(hay);
}
function inferImageGen(m) {
	let hay = `${m.id ?? ''} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
	if (/(^|[^a-z])picture_[a-z0-9_]+/.test(hay)) return true;
	if (/(^|\s)(model|video|audio)_[a-z0-9_]+(\s|$)/.test(hay)) {
		hay = hay.replace(/(model|video|audio)_[a-z0-9_]+/g, ' ');
	}
	return /(^|[^a-z])(dall-?e|gpt-image|flux|stable-diffusion|sdxl|sd3|seedream|ideogram|imagen|recraft|kandinsky|sana|hunyuan[- _]image|kolors|pixart|nano[- _]?banana|image)([^a-z]|$)/.test(hay);
}

const headers = { 'user-agent': 'Mozilla/5.0', accept: 'text/html' };

(async () => {
	const html = await fetch(`${FLOOD}/`, { headers }).then(r => r.text());
	const entry = [...html.matchAll(/src="(\/[^"]+\.js)"/g)].map(m => m[1]);
	const fetched = new Map();
	let frontier = [...entry];
	for (let d = 0; d < 3 && frontier.length; d++) {
		const next = [];
		for (const u of frontier) {
			if (fetched.has(u) || fetched.size > 80) continue;
			try {
				const js = await fetch(`${FLOOD}${u}`, { headers }).then(r => r.text());
				fetched.set(u, js);
				for (const c of js.matchAll(/"((?:\.\/)?assets\/[A-Za-z0-9_-]+\.js)"/g)) {
					const raw = c[1].replace(/^\.\//, '');
					const p = raw.startsWith('/') ? raw : `/${raw}`;
					if (!fetched.has(p) && !next.includes(p)) next.push(p);
				}
			} catch {}
		}
		frontier = next;
	}
	const RE = /value:\s*"((?:picture|video|model|audio)_[A-Za-z0-9_]+)"/g;
	const all = new Set();
	for (const js of fetched.values()) {
		let m;
		while ((m = RE.exec(js))) all.add(m[1]);
	}
	const ids = [...all];
	console.log('total discovered:', ids.length);

	const missV = ids.filter(id => id.startsWith('video_') && !inferVideoGen({ id }));
	const missM = ids.filter(id => id.startsWith('model_') && !inferModelGen({ id }));
	const missA = ids.filter(id => id.startsWith('audio_') && !inferAudioGen({ id }));
	const missI = ids.filter(id => id.startsWith('picture_') && !inferImageGen({ id }));
	const wrongV = ids.filter(id => !id.startsWith('video_') && inferVideoGen({ id }));
	const wrongM = ids.filter(id => !id.startsWith('model_') && inferModelGen({ id }));
	const wrongA = ids.filter(id => !id.startsWith('audio_') && inferAudioGen({ id }));
	const wrongI = ids.filter(id => !id.startsWith('picture_') && inferImageGen({ id }));

	console.log('video: miss =', JSON.stringify(missV), ' cross =', JSON.stringify(wrongV));
	console.log('model: miss =', JSON.stringify(missM), ' cross =', JSON.stringify(wrongM));
	console.log('audio: miss =', JSON.stringify(missA), ' cross =', JSON.stringify(wrongA));
	console.log('image: miss =', JSON.stringify(missI), ' cross =', JSON.stringify(wrongI));

	// 聊天模型反例（不得误判为生成类）
	const chat = ['gpt-5.2', 'claude-opus-4-8', 'gemini-3.5-flash', 'deepseek-v4-pro', 'glm-5.2', 'qwen4-max'];
	const bad = chat.filter(id => inferVideoGen({ id }) || inferModelGen({ id }) || inferAudioGen({ id }) || inferImageGen({ id }));
	console.log('chat false-positives:', JSON.stringify(bad));
	const pass = missV.length + missM.length + missA.length + missI.length + wrongV.length + wrongM.length + wrongA.length + wrongI.length + bad.length === 0;
	console.log(pass ? '=== ALL PASS ===' : '=== HAS FAILURES ===');
	process.exit(pass ? 0 : 1);
})();
