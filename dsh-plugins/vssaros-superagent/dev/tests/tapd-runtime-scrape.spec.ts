import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { createTapdFilterReader, TAPD_FILTER_READ_EXPRESSION, tapdFilterRowsReady } from '../../../vssaros-browser/lib/core/tapdFilters.js'
import { parseDomConditions } from '../src/sources/tapd-filter-schemes.ts'

const chips = '<span class="lblsel-tag">Beta_Test<span class="x">×</span></span>'
const release = `<tr><td class="fld-cell"><span class="fld">发布计划</span></td><td class="op-cell"><span class="op">属于 (In)</span></td><td><div class="lblsel-box">${chips}</div></td><td class="sw-cell"><span class="cvft-sw on"></span></td></tr>`
const html = `<div id="cvKpiLeftBody"><table class="cvft"><tbody>${release}
<tr class="cvft-orgroup"><td colspan="4"><table class="cvft"><tbody>
<tr><td class="fld-cell"><select class="cvft-edit"><option value="priority">优先级</option></select></td><td class="op-cell"><select class="cvft-edit"><option value="in">属于 (In)</option></select></td><td><div class="pchip on" data-pf="urgent"><span class="tick">✓</span>紧急</div><div class="pchip" data-pf="low">低</div></td><td class="sw-cell"><span class="cvft-sw on"></span></td></tr>
<tr class="cvft-row-off"><td class="fld-cell"><select class="cvft-edit"><option value="tag">标签</option></select></td><td class="op-cell"><span class="op">属于 (In)</span></td><td><span class="val-chip">必修bug</span></td><td class="sw-cell"><span class="cvft-sw"></span></td></tr>
</tbody></table></td></tr>
<tr><td class="fld-cell"><span class="fld">创建时间</span></td><td class="op-cell"><span class="op">介于 (Range)</span></td><td><div class="ct-input" data-val="2024-01-09T00:00" data-role="from"></div><div class="ct-input" data-val="2099-09-09T14:00" data-role="to"></div></td></tr>
<tr><td class="fld-cell"><span class="fld">标题</span></td><td class="op-cell"><span class="op">不包含 (Not Like)</span></td><td><span class="val-chip">XSCAN扫描</span><span class="val-chip">x86 异常</span></td></tr>
<tr><td class="fld-cell"><span class="fld">Bug类型</span></td><td class="op-cell"><select class="cvft-edit"><option value="in">属于 (In)</option></select></td><td><div class="lblsel-box"><span class="lblsel-tag">功能<span class="x">×</span></span></div></td></tr>
</tbody></table></div>`

function collect(pageHtml = html, url = 'http://saroasisstudiosystem.saroasis.woa.com:9999/bug/client.html') {
  const dom = new JSDOM(pageHtml, { url, runScripts: 'outside-only' })
  try { return parseDomConditions(dom.window.eval(TAPD_FILTER_READ_EXPRESSION)) }
  finally { dom.window.close() }
}

describe('runtime filter collection', () => {
  it('collects leaf rows only and preserves selected labels, priority switches and OR groups', () => {
    const rows = collect()
    expect(rows).toHaveLength(6)
    expect(rows.find(row => row.field === '优先级')).toMatchObject({ value: ['紧急'], group: 'or1', enabled: true })
    expect(rows.find(row => row.field === '标签')).toMatchObject({ value: ['必修bug'], group: 'or1', enabled: false })
    expect(rows.find(row => row.field === 'Bug类型')?.op).toBe('属于 (In)')
    expect(rows[0]?.value).toEqual(['Beta_Test'])
  })
  it('reads custom date controls and does not remove letters x/X from legitimate values', () => {
    const rows = collect()
    expect(rows.find(row => row.field === '创建时间')?.value).toEqual({ from: '2024-01-09T00:00', to: '2099-09-09T14:00' })
    expect(rows.find(row => row.field === '标题')?.value).toEqual(['XSCAN扫描', 'x86 异常'])
  })
  it('reads second-precision native datetime inputs on the story page', () => {
    const story = `<div id="storyFilterBody"><table class="cvft"><tbody>${release}<tr><td class="fld-cell"><span class="fld">预计完成时间</span></td><td class="op-cell"><span class="op">介于 (Range)</span></td><td><input type="datetime-local" step="1" value="2024-01-09T00:00"><input type="datetime-local" step="1" value="2026-09-30T23:59:59"></td></tr></tbody></table></div>`
    expect(collect(story, 'http://saroasisstudiosystem.saroasis.woa.com:9999/story/main.html')[1]?.value)
      .toEqual({ from: '2024-01-09T00:00', to: '2026-09-30T23:59:59' })
  })
  it('fails closed on a redirect outside the fixed source allowlist', () => {
    expect(() => collect(html, 'http://example.test/bug.html')).toThrow('outside the permitted source')
  })
  it('distinguishes HTML-ready shells from complete runtime values', () => {
    expect(tapdFilterRowsReady([{ field: '发布计划', op: 'in', values: [], enabled: true }])).toBe(false)
    expect(tapdFilterRowsReady([{ field: '发布计划', op: 'in', values: ['A'], enabled: true },
      { field: '优先级', op: 'in', values: [], enabled: true }])).toBe(false)
  })
  it('releases only its owned page on failure and continues later requests', async () => {
    const close = vi.fn(async () => undefined)
    const navigate = vi.fn(async () => undefined)
    const ready = [{ field: '发布计划', op: 'in', values: ['A'], range: [], enabled: true }, { field: '状态', op: 'in', values: ['new'], range: [], enabled: true }]
    const evaluate = vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValue(ready)
    const reader = createTapdFilterReader(() => ({ navigate, closeOwnedPage: close, evaluateAsync: evaluate }))
    await expect(reader.read('story')).rejects.toThrow('unreachable')
    await expect(reader.read('bug')).resolves.toEqual(ready)
    expect(close).toHaveBeenCalledTimes(2)
    expect(navigate.mock.calls).toHaveLength(2)
    expect(Object.keys(reader)).toEqual(['read'])
  })
})
