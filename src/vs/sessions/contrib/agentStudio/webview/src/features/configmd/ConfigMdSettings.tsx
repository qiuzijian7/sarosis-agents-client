/*---------------------------------------------------------------------------------------------
 *  ConfigMdSettings — popover for managing custom parser and styles.
 *
 *  Allows the user to:
 *    • Upload a custom MD→HTML parser (.js)
 *    • Upload custom preview CSS (.css)
 *    • Restore the built-in parser
 *    • Inspect current parser/styles status
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useRef, useState } from 'react';
import {
	getInfo,
	removeParser,
	uploadParser,
	uploadStyles,
	type ConfigMdInfo,
} from './configMdBridge';

interface ConfigMdSettingsProps {
	agentId: string;
	onClose: () => void;
	onChanged?: () => void;
}

export const ConfigMdSettings: React.FC<ConfigMdSettingsProps> = ({ agentId, onClose, onChanged }) => {
	const [info, setInfo] = useState<ConfigMdInfo | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [success, setSuccess] = useState<string | undefined>();
	const parserInputRef = useRef<HTMLInputElement | null>(null);
	const stylesInputRef = useRef<HTMLInputElement | null>(null);

	const load = async () => {
		try {
			const r = await getInfo(agentId);
			setInfo(r);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	useEffect(() => { void load(); }, [agentId]);

	const handleParserSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) { return; }
		if (!/\.js$/i.test(file.name)) {
			setError('解析器必须是 .js 文件');
			return;
		}
		setBusy(true);
		setError(undefined);
		setSuccess(undefined);
		try {
			const content = await file.text();
			const r = await uploadParser(agentId, content, file.name);
			setSuccess(`解析器已上传：${r.parserPath}`);
			await load();
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			if (parserInputRef.current) { parserInputRef.current.value = ''; }
		}
	};

	const handleStylesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) { return; }
		if (!/\.css$/i.test(file.name)) {
			setError('样式文件必须是 .css 文件');
			return;
		}
		setBusy(true);
		setError(undefined);
		setSuccess(undefined);
		try {
			const content = await file.text();
			const r = await uploadStyles(agentId, content, file.name);
			setSuccess(`样式已上传：${r.stylesPath}`);
			await load();
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			if (stylesInputRef.current) { stylesInputRef.current.value = ''; }
		}
	};

	const handleRemoveParser = async () => {
		if (!info?.parserPath) { return; }
		setBusy(true);
		setError(undefined);
		setSuccess(undefined);
		try {
			await removeParser(agentId);
			setSuccess('已恢复内置解析器');
			await load();
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="configmd-settings-overlay" onClick={onClose}>
			<div className="configmd-settings-panel" onClick={(e) => e.stopPropagation()}>
				<div className="configmd-settings-header">
					<span className="configmd-settings-title">⚙ ConfigMD 配置</span>
					<button className="configmd-settings-close" onClick={onClose} title="关闭">×</button>
				</div>
				<div className="configmd-settings-body">
					{/* Parser section */}
					<div className="configmd-settings-section">
						<div className="configmd-settings-section-title">MD → HTML 解析器</div>
						<div className="configmd-settings-row">
							<span className="configmd-settings-label">当前：</span>
							<span className={`configmd-settings-value ${info?.parserSource === 'custom' ? 'is-custom' : ''}`}>
								{info?.parserSource === 'custom' ? `自定义 (${info.parserPath})` : '内置解析器'}
							</span>
						</div>
						<div className="configmd-settings-actions">
							<button
								className="configmd-settings-btn primary"
								onClick={() => parserInputRef.current?.click()}
								disabled={busy}
							>
								上传 parser.js
							</button>
							{info?.parserSource === 'custom' && (
								<button
									className="configmd-settings-btn secondary"
									onClick={handleRemoveParser}
									disabled={busy}
								>
									恢复内置
								</button>
							)}
							<input
								ref={parserInputRef}
								type="file"
								accept=".js,application/javascript"
								onChange={handleParserSelect}
								style={{ display: 'none' }}
							/>
						</div>
						<div className="configmd-settings-hint">
							脚本须导出 <code>{'{ parse(markdown, ctx) }'}</code>，CommonJS 或 <code>exports.default</code> 均可。
						</div>
					</div>

					{/* Styles section */}
					<div className="configmd-settings-section">
						<div className="configmd-settings-section-title">预览样式（可选）</div>
						<div className="configmd-settings-row">
							<span className="configmd-settings-label">当前：</span>
							<span className={`configmd-settings-value ${info?.hasStyles ? 'is-custom' : ''}`}>
								{info?.hasStyles ? `自定义 (${info?.stylesPath || 'ui/styles.css'})` : '默认样式'}
							</span>
						</div>
						<div className="configmd-settings-actions">
							<button
								className="configmd-settings-btn primary"
								onClick={() => stylesInputRef.current?.click()}
								disabled={busy}
							>
								上传 styles.css
							</button>
							<input
								ref={stylesInputRef}
								type="file"
								accept=".css,text/css"
								onChange={handleStylesSelect}
								style={{ display: 'none' }}
							/>
						</div>
					</div>

					{/* Status */}
					{busy && <div className="configmd-settings-status busy">处理中…</div>}
					{error && <div className="configmd-settings-status error">⚠ {error}</div>}
					{success && <div className="configmd-settings-status ok">✓ {success}</div>}
				</div>
			</div>
		</div>
	);
};
