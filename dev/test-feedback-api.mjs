/**
 * 测试工蜂 Issue 创建功能
 *
 * 用法:
 *   node dev/test-feedback-api.mjs <personal-access-token>
 *
 * 获取 token:
 *   工蜂 → 个人设置 → 访问令牌 → 创建令牌(勾选 api 权限)
 *
 * 测试内容:
 *   1. 验证 token 有效性 (GET /api/v4/user)
 *   2. 创建测试 issue (POST /api/v4/projects/:id/issues)
 *   3. 上传测试图片 (POST /api/v4/projects/:id/uploads)
 */

const GONGFENG_BASE = 'https://git.woa.com';
const PROJECT_PATH = 'zijianqiu%2Fsarosis-agents-client';
const TOKEN = process.argv[2];

if (!TOKEN) {
	console.error('❌ 请提供工蜂 personal access token');
	console.error('   用法: node dev/test-feedback-api.mjs <token>');
	console.error('   获取: 工蜂 → 个人设置 → 访问令牌 → 创建令牌(勾选 api)');
	process.exit(1);
}

const headers = { 'PRIVATE-TOKEN': TOKEN };

async function api(method, path, body) {
	const url = `${GONGFENG_BASE}/api/v4${path}`;
	const opts = {
		method,
		headers: { ...headers },
	};
	if (body) {
		opts.headers['Content-Type'] = 'application/json';
		opts.body = JSON.stringify(body);
	}
	console.log(`  → ${method} ${url}`);
	const res = await fetch(url, opts);
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, body: json };
}

async function uploadImage(filename, base64Data, mimeType) {
	const url = `${GONGFENG_BASE}/api/v4/projects/${PROJECT_PATH}/uploads`;
	const buffer = Buffer.from(base64Data, 'base64');
	const boundary = '----TestBoundary' + Math.random().toString(16).slice(2);
	const header = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
	);
	const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
	const body = Buffer.concat([header, buffer, footer]);

	console.log(`  → POST ${url} (multipart, ${buffer.length} bytes)`);
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'PRIVATE-TOKEN': TOKEN,
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
			'Content-Length': body.length,
		},
		body,
	});
	const text = await res.text();
	let json;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: res.status, body: json };
}

async function main() {
	console.log('═══════════════════════════════════════════════════');
	console.log('  工蜂 Issue 创建测试');
	console.log('═══════════════════════════════════════════════════\n');

	// ── 1. 验证 token ──
	console.log('【步骤 1】验证 token 有效性...');
	const userRes = await api('GET', '/user');
	if (userRes.status !== 200) {
		console.error(`❌ Token 无效: HTTP ${userRes.status}`, userRes.body);
		process.exit(1);
	}
	console.log(`✅ Token 有效，当前用户: ${userRes.body.username} (id=${userRes.body.id})\n`);

	// ── 2. 创建测试 issue ──
	console.log('【步骤 2】创建测试 Issue...');
	const issueTitle = `[Bug] 测试 Issue - ${new Date().toISOString().slice(0, 19)}`;
	const issueDesc = `## 反馈信息\n\n| 字段 | 值 |\n|------|------|\n| 类型 | Bug 报告 |\n| 提交者 | ${userRes.body.username} |\n| 版本 | v2.2.25883 (61889cc1) |\n| 平台 | win32-x64 |\n| 提交时间 | ${new Date().toISOString()} |\n\n## 问题描述\n\n这是一个测试 Issue，由 test-feedback-api.mjs 自动创建。\n`;

	const issueRes = await api('POST', `/projects/${PROJECT_PATH}/issues`, {
		title: issueTitle,
		description: issueDesc,
		labels: 'bug',
	});

	if (issueRes.status === 201 || issueRes.status === 200) {
		console.log(`✅ Issue 创建成功!`);
		console.log(`   IID: #${issueRes.body.iid}`);
		console.log(`   URL: ${issueRes.body.web_url}`);
		console.log(`   标题: ${issueRes.body.title}\n`);
	} else {
		console.error(`❌ Issue 创建失败: HTTP ${issueRes.status}`, issueRes.body);
		process.exit(1);
	}

	// ── 3. 上传测试图片 ──
	console.log('【步骤 3】上传测试图片...');
	// 1x1 红色 PNG
	const testPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
	const uploadRes = await uploadImage('test-screenshot.png', testPngBase64, 'image/png');

	if (uploadRes.status === 201 || uploadRes.status === 200) {
		console.log(`✅ 图片上传成功!`);
		console.log(`   Markdown: ${uploadRes.body.markdown}`);
		console.log(`   URL: ${GONGFENG_BASE}${uploadRes.body.url}\n`);
	} else {
		console.error(`❌ 图片上传失败: HTTP ${uploadRes.status}`, uploadRes.body);
	}

	// ── 4. 创建带图片的 issue（可选）──
	if (uploadRes.body?.markdown) {
		console.log('【步骤 4】创建带截图的测试 Issue...');
		const issueWithImgRes = await api('POST', `/projects/${PROJECT_PATH}/issues`, {
			title: `[Feature] 带截图测试 - ${new Date().toISOString().slice(0, 19)}`,
			description: `${issueDesc}\n## 截图\n\n${uploadRes.body.markdown}\n`,
			labels: 'feature-request',
		});

		if (issueWithImgRes.status === 201 || issueWithImgRes.status === 200) {
			console.log(`✅ 带截图 Issue 创建成功!`);
			console.log(`   IID: #${issueWithImgRes.body.iid}`);
			console.log(`   URL: ${issueWithImgRes.body.web_url}\n`);
		} else {
			console.error(`❌ 带截图 Issue 创建失败: HTTP ${issueWithImgRes.status}`, issueWithImgRes.body);
		}
	}

	console.log('═══════════════════════════════════════════════════');
	console.log('  测试完成!');
	console.log('═══════════════════════════════════════════════════');
}

main().catch(err => {
	console.error('❌ 测试出错:', err);
	process.exit(1);
});
