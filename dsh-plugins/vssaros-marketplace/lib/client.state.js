(function () {
	'use strict';
	function itemKey(item) { return String(item.kind || '') + ':' + String(item.slug || item.storeId || item.id || ''); }
	function mergePage(before, incoming) {
		var map = new Map();
		before.concat(incoming).forEach(function (item) { map.set(itemKey(item), item); });
		return Array.from(map.values());
	}
	function createGate() {
		var channels = new Map();
		function cancel(channel) { var previous = channels.get(channel); if (previous) { previous.abort(); } channels.delete(channel); }
		return {
			begin: function (channel) {
				cancel(channel);
				var controller = new AbortController(); channels.set(channel, controller);
				return { signal: controller.signal, current: function () { return channels.get(channel) === controller; } };
			},
			cancel: cancel,
			dispose: function () { Array.from(channels.keys()).forEach(cancel); }
		};
	}
	function createOperations() {
		var records = new Map(), listeners = new Set();
		function emit() { listeners.forEach(function (listener) { listener(); }); }
		return {
			get: function (key) { return records.get(key) || { pending: false, error: '' }; },
			subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener); }; },
			begin: function (key, op) {
				if (records.get(key) && records.get(key).pending) { return null; }
				var record = { pending: true, op: op, error: '' }; records.set(key, record); emit();
				return function (error) {
					if (records.get(key) !== record) { return; }
					records.set(key, { pending: false, op: op, error: error || '' });
					if (records.size > 256) { for (var entry of records) { if (!entry[1].pending && entry[0] !== key) { records.delete(entry[0]); break; } } }
					emit();
				};
			}
		};
	}
	function stable(value) {
		if (Array.isArray(value)) { return value.map(stable); }
		if (!value || typeof value !== 'object') { return value; }
		var out = {}; Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); }); return out;
	}
	function createReadClient(options) {
		options = options || {};
		var endpoint = options.endpoint || '/x/marketplace/api/action', fetchImpl = options.fetchImpl || window.fetch.bind(window);
		var timeout = options.timeoutMs || 20000, maxCache = options.maxCache || 12;
		var cache = new Map(), pending = new Map(), disposed = false, revision = 0;
		function cancelled() { return { ok: false, cancelled: true, error: '读取已取消' }; }
		function read(op, params, opts) {
			opts = opts || {}; params = params || {};
			if (disposed || (opts.signal && opts.signal.aborted)) { return Promise.resolve(cancelled()); }
			var key = endpoint + ':' + op + ':' + JSON.stringify(stable(params));
			var canCache = op === 'list' && !params.scope;
			if (opts.force) { cache.delete(key); }
			var saved = cache.get(key);
			if (saved && saved.expires > Date.now()) { cache.delete(key); cache.set(key, saved); return Promise.resolve(saved.value); }
			var record = pending.get(key);
			if (!record) {
				var controller = new AbortController(), timer;
				record = { controller: controller, revision: revision };
				var expired = new Promise(function (resolve) { timer = setTimeout(function () { controller.abort(); resolve({ ok: false, error: '商城读取超时，请重试' }); }, timeout); });
				var work = Promise.resolve().then(function () { return fetchImpl(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: op, params: params }), signal: controller.signal }); })
					.then(function (response) { if (!response.ok) { throw new Error('商城读取 HTTP ' + response.status); } return response.json(); })
					.catch(function (error) { return { ok: false, error: String(error.message || error) }; });
				record.promise = Promise.race([work, expired]).then(function (value) {
					clearTimeout(timer); if (pending.get(key) === record) { pending.delete(key); }
					if (!value || typeof value !== 'object') { return { ok: false, error: '商城没有有效回执' }; }
					if (canCache && value.ok === true && !disposed && record.revision === revision) {
						cache.set(key, { value: value, expires: Date.now() + 15000 });
						while (cache.size > maxCache) { cache.delete(cache.keys().next().value); }
					}
					return value;
				});
				pending.set(key, record);
			}
			if (!opts.signal) { return record.promise; }
			return new Promise(function (resolve) {
				var abort = function () { opts.signal.removeEventListener('abort', abort); resolve(cancelled()); };
				opts.signal.addEventListener('abort', abort, { once: true });
				record.promise.then(function (value) { opts.signal.removeEventListener('abort', abort); resolve(value); });
			});
		}
		return { read: read, invalidate: function () { revision++; cache.clear(); pending.clear(); }, dispose: function () { disposed = true; cache.clear(); pending.forEach(function (r) { r.controller.abort(); }); } };
	}
	/** ★ 2026-11-23：把 Host 侧 rollbackList 的平面投影按「资源」分组（最近备份排最前）。 */
	function groupRollbackPoints(items) {
		var list = Array.isArray(items) ? items : [];
		var groups = new Map();
		list.forEach(function (p) {
			if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id || typeof p.ts !== 'string' || !p.ts) { return; }
			var kind = typeof p.kind === 'string' ? p.kind : '';
			var key = kind + ':' + p.id;
			var point = { id: p.id, ts: p.ts, kind: kind, createdAt: typeof p.createdAt === 'string' ? p.createdAt : p.ts };
			var prev = groups.get(key);
			if (!prev) { groups.set(key, { key: key, id: p.id, kind: kind, latest: point, points: [point] }); return; }
			prev.points.push(point);
			if (point.ts > prev.latest.ts) { prev.latest = point; }
		});
		var out = Array.from(groups.values());
		out.forEach(function (g) { g.points.sort(function (a, b) { return b.ts.localeCompare(a.ts); }); });
		out.sort(function (a, b) { return b.latest.ts.localeCompare(a.latest.ts); });
		return { groups: out, total: list.length };
	}
	/** 从分组里取一个具体备份点；`ts` 缺省 = 该资源最近一次备份。 */
	function pickRollbackPoint(groups, key, ts) {
		var g = (Array.isArray(groups) ? groups : []).filter(function (x) { return x && x.key === key; })[0];
		if (!g) { return null; }
		if (!ts) { return g.latest || null; }
		return g.points.filter(function (p) { return p.ts === ts; })[0] || null;
	}
	window.MarketplaceState = {
		itemKey: itemKey, mergePage: mergePage, createGate: createGate,
		createOperations: createOperations, createReadClient: createReadClient,
		groupRollbackPoints: groupRollbackPoints, pickRollbackPoint: pickRollbackPoint
	};
})();
