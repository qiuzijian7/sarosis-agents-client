// 探针：读 dsh Host 的中转站工作台接口（Host 的 HTTP 口要先开 authUrl 拿 cookie）。
import fs from 'node:fs';

const home = process.env.USERPROFILE;
const hostJson = JSON.parse(fs.readFileSync(home + '/.vssaros/dsh-home/host.json', 'utf8'));
const token = String(hostJson.authUrl).split('token=')[1];
const origin = hostJson.origin;

// ⚠ 必须 `redirect: 'manual'`：cookie 是设在 **302** 那一步的，跟随后就看不到它了（⇒ 后面全 401）✗
const r0 = await fetch(origin + '/?token=' + token, { redirect: 'manual' });
const cookie = (r0.headers.getSetCookie?.() || []).map(c => String(c).split(';')[0]).join('; ');
const get = async (p) => {
	try {
		return await (await fetch(origin + p, { headers: { cookie } })).text();
	} catch (e) {
		return 'ERR ' + String(e);
	}
};

console.log('host pid =', hostJson.pid);
console.log('--- agent ---');
console.log(await get('/x/relay/api/agent'));
console.log('--- agent logs ---');
console.log(await get('/x/relay/api/agent/logs'));
console.log('--- nodes ---');
console.log(await get('/x/relay/api/nodes'));
