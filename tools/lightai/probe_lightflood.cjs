/* 探测 lightflood 接口：get_voucher → canvas/detail → user-configs/me → model-history */
const CANVAS_ID = process.env.CANVAS_ID || '832';
const BASE = 'https://lightai-lightflood-v1-sd.aigclsp.com';
const COOKIE = process.env.LIGHTAI_COOKIE || '';
const USERID = process.env.LIGHTAI_USERID || '';
const USER_DATA = Buffer.from(`${USERID}-lightai`).toString('base64');
const APP_ID = '169';

const baseHeaders = {
	accept: '*/*',
	'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
	origin: BASE,
	referer: `${BASE}/flow`,
	app_id: APP_ID,
	biz_id: '73',
	version: '1.0',
	'user-data': USER_DATA,
	cookie: COOKIE,
};

(async () => {
	// ① get_voucher
	const v = await fetch(`${BASE}/api/light_flood/canvas/get_voucher`, { headers: baseHeaders }).then(r => r.json());
	if (v.code !== 200) { console.error('get_voucher 失败:', JSON.stringify(v)); process.exit(1); }
	const token = v.data;
	console.log('[voucher] OK (JWT len=' + token.length + ')');
	const h = { ...baseHeaders, 'lf_canvas_auth': token, 'content-type': 'application/json' };

	// ② canvas/detail
	const d = await fetch(`${BASE}/api/light_flood/canvas/detail?canvas_id=${CANVAS_ID}`, { headers: h }).then(r => r.json());
	console.log('\n[canvas/detail] code=' + d.code);
	const dstr = JSON.stringify(d);
	console.log(dstr.slice(0, 3600));

	// ③ user-configs/me
	const me = await fetch(`${BASE}/api/light_flood/user-configs/me`, { headers: h }).then(r => r.json());
	console.log('\n[user-configs/me] code=' + me.code);
	console.log(JSON.stringify(me).slice(0, 2500));

	// ④ global-preset + model-history
	const gp = await fetch(`${BASE}/api/light_flood/user-configs/global-preset`, { headers: h }).then(r => r.json());
	console.log('\n[global-preset] code=' + gp.code);
	console.log(JSON.stringify(gp).slice(0, 2000));
	const mh = await fetch(`${BASE}/api/light_flood/user-configs/global-preset/model-history`, { headers: h }).then(r => r.json());
	console.log('\n[model-history] code=' + mh.code);
	console.log(JSON.stringify(mh).slice(0, 4000));
})().catch(e => { console.error('EXCEPTION:', e.message); process.exit(1); });
