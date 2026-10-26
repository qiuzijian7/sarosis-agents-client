/*
 * 独立文档页（`/x/kb/doc?uri=`）的启动脚本。
 *
 * 2026-10-26（P4）：从页内 `<script>` 外置到这里 —— 只有外置才能开严格 CSP
 * （`script-src 'self'`），否则必须写 `'unsafe-inline'`，等于没加防护。
 *
 * 只做一件事：把正文里的 `[[双链]]`（渲染器产出 `data-wiki="绝对路径"`）变成可点跳转。
 * ⚠ 本文件由 `/x/kb/web/doc-boot.js` 直接服务（不必重新生成），改了刷新即生效。
 */
(function () {
	'use strict';
	var doc = document.getElementById('doc');
	if (!doc) { return; }
	doc.addEventListener('click', function (ev) {
		var el = ev.target;
		var a = el && el.closest ? el.closest('[data-wiki]') : null;
		if (!a) { return; }
		ev.preventDefault();
		var p = a.getAttribute('data-wiki');
		if (p) { window.location.href = '/x/kb/doc?uri=' + encodeURIComponent(p); }
	});
})();
