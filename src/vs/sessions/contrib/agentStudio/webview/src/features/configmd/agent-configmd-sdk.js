/*---------------------------------------------------------------------------------------------
 *  agent-configmd-sdk.js
 *
 *  Lightweight SDK to embed in custom HTML views rendered from agent's config.md.
 *  Communicates with the parent ConfigMDPanel via window.postMessage.
 *
 *  Usage in custom HTML:
 *    <script src="agent-configmd-sdk.js"></script>
 *    <script>
 *      const agent = AgentConfigMd.connect();
 *      agent.on('command', (cmd) => { ... });
 *      agent.on('sync', ({ markdown, version, origin }) => { ... });
 *      btn.onclick = () => agent.sendEvent('confirm', { value: 1 });
 *      // Mutate the canonical MD:
 *      await agent.applyPatch([{ op: 'replace-anchor', anchor: 'tasks', content: '- [x] done' }]);
 *      // Or read/write the whole file:
 *      const { markdown, version } = await agent.readMd();
 *      await agent.writeMd(markdown + '\n\nappended');
 *    </script>
 *
 *  When using the BUILT-IN parser (no custom parser.js), this SDK is auto-injected
 *  into the rendered preview iframe. For custom parser-rendered HTML, include the
 *  script tag manually or call the API via window.parent.postMessage directly.
 *--------------------------------------------------------------------------------------------*/

(function (global) {
	'use strict';

	function nextId() {
		return 'sdk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
	}

	function AgentConfigMdClient() {
		this._connected = false;
		this._pending = new Map();
		this._listeners = { command: [], sync: [], connected: [] };
		this._ctx = null;
		this._installMessageListener();
	}

	AgentConfigMdClient.prototype._installMessageListener = function () {
		var self = this;
		window.addEventListener('message', function (event) {
			var msg = event.data;
			if (!msg || typeof msg !== 'object') { return; }
			// SDK reply
			if (msg.type === 'sdk.reply' && msg.requestId && self._pending.has(msg.requestId)) {
				var p = self._pending.get(msg.requestId);
				self._pending.delete(msg.requestId);
				if (msg.ok) { p.resolve(msg.data); } else { p.reject(new Error(msg.error || 'sdk error')); }
				return;
			}
			// Host pushes
			if (msg.type === 'host.command') {
				self._listeners.command.forEach(function (fn) {
					try { fn(msg.command); } catch (e) { /* ignore */ }
				});
			} else if (msg.type === 'host.sync') {
				self._listeners.sync.forEach(function (fn) {
					try { fn({ markdown: msg.markdown, version: msg.version, origin: msg.origin }); } catch (e) { /* ignore */ }
				});
			}
		});
	};

	AgentConfigMdClient.prototype._send = function (type, extra) {
		var self = this;
		var requestId = nextId();
		return new Promise(function (resolve, reject) {
			self._pending.set(requestId, { resolve: resolve, reject: reject });
			var msg = Object.assign({ type: type, requestId: requestId }, extra || {});
			window.parent.postMessage(msg, '*');
			setTimeout(function () {
				if (self._pending.has(requestId)) {
					self._pending.delete(requestId);
					reject(new Error('sdk request timeout: ' + type));
				}
			}, 30000);
		});
	};

	AgentConfigMdClient.prototype.connect = function () {
		var self = this;
		return this._send('sdk.ready', {}).then(function (data) {
			self._connected = true;
			self._ctx = data || {};
			self._listeners.connected.forEach(function (fn) {
				try { fn(self._ctx); } catch (e) { /* ignore */ }
			});
			return self;
		});
	};

	AgentConfigMdClient.prototype.on = function (event, fn) {
		if (!this._listeners[event]) { this._listeners[event] = []; }
		this._listeners[event].push(fn);
		return this;
	};

	AgentConfigMdClient.prototype.sendEvent = function (eventName, payload) {
		return this._send('sdk.event', { eventName: eventName, payload: payload });
	};

	AgentConfigMdClient.prototype.chatSend = function (message, options) {
		var opts = options || {};
		return this._send('sdk.chatSend', {
			message: message,
			context: opts.context,
			showInChat: opts.showInChat !== false,
		});
	};

	AgentConfigMdClient.prototype.readMd = function () {
		return this._send('sdk.readMd', {});
	};

	AgentConfigMdClient.prototype.writeMd = function (markdown) {
		return this._send('sdk.writeMd', { markdown: markdown });
	};

	AgentConfigMdClient.prototype.applyPatch = function (patches) {
		var arr = Array.isArray(patches) ? patches : [patches];
		return this._send('sdk.applyPatch', { patches: arr });
	};

	AgentConfigMdClient.prototype.notify = function (message, level) {
		return this._send('sdk.notify', { message: message, level: level || 'info' });
	};

	// Convenience: bind data-agent-task checkboxes to MD task-list state
	// (only meaningful for built-in renderer's `<input data-agent-task>` elements).
	AgentConfigMdClient.prototype.bindTaskList = function (anchor) {
		var self = this;
		document.querySelectorAll('[data-agent-state="' + anchor + '"] [data-agent-task]').forEach(function (el) {
			el.addEventListener('change', function () {
				var items = [];
				document.querySelectorAll('[data-agent-state="' + anchor + '"] li').forEach(function (li) {
					var input = li.querySelector('[data-agent-task]');
					var text = (li.textContent || '').trim();
					var checked = !!(input && input.checked);
					items.push('- [' + (checked ? 'x' : ' ') + '] ' + text);
				});
				self.applyPatch([{ op: 'replace-anchor', anchor: anchor, content: items.join('\n') }]);
			});
		});
		return this;
	};

	global.AgentConfigMd = {
		/** Create and auto-connect a client. */
		connect: function () {
			var c = new AgentConfigMdClient();
			return c.connect();
		},
		/** Create without auto-connecting. */
		create: function () { return new AgentConfigMdClient(); },
	};
})(typeof window !== 'undefined' ? window : this);
