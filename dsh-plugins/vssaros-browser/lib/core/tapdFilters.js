/** Fixed read-only platform collector. No arbitrary URLs, scripts, cookies or shared rightbar navigation. */
export const TAPD_FILTER_PAGES = Object.freeze({
	story: 'http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html',
	bug: 'http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html',
});

function collectTapdFilterRows() {
	if (location.href === 'about:blank') return [];
	const permitted = ['http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html', 'http://saroasisstudiosystem.saroasis.woa.com:9999/bug.html', 'http://saroasisstudiosystem.saroasis.woa.com:9999/bug/client.html'];
	if (!permitted.includes(location.origin + location.pathname)) throw new Error('TAPD page redirected outside the permitted source');
	const root = document.querySelector('#storyFilterBody') || document.querySelector('#cvKpiLeftBody');
	if (!root) return [];
	const groupRows = [...root.querySelectorAll('tr.cvft-orgroup')];
	const cleanText = element => {
		const copy = element.cloneNode(true);
		copy.querySelectorAll('.x, .tick, .cnt').forEach(child => child.remove());
		return copy.textContent.trim();
	};
	const readField = element => element?.tagName === 'SELECT' ? element.selectedOptions[0]?.textContent.trim() : element?.textContent.trim();
	return [...root.querySelectorAll('table.cvft tr')].flatMap(tr => {
		const cells = [...tr.children];
		const fieldCell = cells.find(cell => cell.classList.contains('fld-cell'));
		if (!fieldCell) return [];
		const opCell = cells.find(cell => cell.classList.contains('op-cell'));
		const field = readField(fieldCell.querySelector('.fld, select.cvft-edit')) || '';
		const op = readField(opCell?.querySelector('.op, select.cvft-edit')) || '';
		if (!field || !op) return [];
		const cell = cells[2];
		if (!cell) return [];
		const chips = [...cell.querySelectorAll('.val-chip, .lblsel-box .lblsel-tag, .pchip.on')];
		const values = chips.map(cleanText).filter(Boolean);
		let range = [...cell.querySelectorAll('input[type="datetime-local"], .ct-input[data-val]')]
			.map(input => input.getAttribute('data-val') ?? input.value ?? '');
		if (/介于|range/i.test(op) && !range.some(Boolean)) {
			const text = cell.textContent.trim().split(/\s*[~～]\s*/);
			if (text.length === 2 && text.every(value => /^\d{4}-\d{2}-\d{2}/.test(value))) range = text;
		}
		if (!values.length && !/介于|range/i.test(op)) {
			const selected = [...cell.querySelectorAll('input[type="checkbox"]:checked')].filter(input => !input.hasAttribute('data-all'));
			for (const input of selected) {
				const label = input.closest('label')?.querySelector('.nm');
				if (label) values.push(label.textContent.trim());
			}
		}
		const sw = cells.find(td => td.classList.contains('sw-cell'))?.querySelector('.cvft-sw');
		const group = tr.closest('tr.cvft-orgroup');
		return [{ field, op, values: [...new Set(values)], range,
			enabled: !tr.classList.contains('cvft-row-off') && (!sw || sw.classList.contains('on')),
			...(group ? { group: `or${groupRows.indexOf(group) + 1}` } : {}) }];
	});
}

export const TAPD_FILTER_READ_EXPRESSION = `(${collectTapdFilterRows.toString()})()`;

/** Readiness means all active rows have runtime values, not just a finished HTML load. */
export function tapdFilterRowsReady(rows) {
	return Array.isArray(rows) && rows.length >= 2 && rows.some(row => row.field === '发布计划' && row.values?.length)
		&& rows.every(row => row.enabled === false || /^(处理人|修复人)$/.test(row.field)
			|| (/介于|range/i.test(row.op) ? row.range?.some(Boolean) : row.values?.length));
}

/** Calls only fixed page navigation and the fixed DOM reader. Calls serialize and release only owned tabs. */
export function createTapdFilterReader(clientFactory, options = {}) {
	const timeoutMs = options.timeoutMs ?? 25_000;
	let previous = Promise.resolve();
	const read = kind => {
		if (!Object.hasOwn(TAPD_FILTER_PAGES, kind)) return Promise.reject(new Error('Unknown TAPD source'));
		const work = previous.then(async () => {
			const client = clientFactory(kind);
			try {
				await client.navigate(TAPD_FILTER_PAGES[kind]);
				const end = Date.now() + timeoutMs;
				do {
					const rows = await client.evaluateAsync(TAPD_FILTER_READ_EXPRESSION, Math.max(100, end - Date.now()));
					if (tapdFilterRowsReady(rows)) return rows;
					await new Promise(resolve => setTimeout(resolve, 200));
				} while (Date.now() < end);
				throw new Error(`${kind}: platform filter values not ready before timeout`);
			} finally { await client.closeOwnedPage(); }
		});
		previous = work.catch(() => undefined);
		return work;
	};
	return { read };
}
