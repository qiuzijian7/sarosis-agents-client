/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Skill Missing Dialog
 *  Dialog shown when an agent references skills that are missing from the skill library.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback } from 'react';
import { useAgentStore } from '../../store/useAgentStore';

interface SkillMissingDialogProps {
	employeeId: string;
	missingSkillIds: string[];
	onClose: () => void;
	onIgnore?: () => void;
	onInstall?: (skillIds: string[]) => void;
}

export function SkillMissingDialog({ 
	employeeId, 
	missingSkillIds, 
	onClose, 
	onIgnore, 
	onInstall 
}: SkillMissingDialogProps): React.ReactElement {
	const [isInstalling, setIsInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);

	const handleIgnore = useCallback(() => {
		onIgnore?.();
		onClose();
	}, [onIgnore, onClose]);

	const handleInstall = useCallback(async () => {
		if (!onInstall || isInstalling) { return; }
		setIsInstalling(true);
		setInstallError(null);
		try {
			await onInstall(missingSkillIds);
			onClose();
		} catch (err) {
			setInstallError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsInstalling(false);
		}
	}, [onInstall, isInstalling, missingSkillIds, onClose]);

	if (missingSkillIds.length === 0) {
		return <></>;
	}

	return (
		<div className="employee-form-overlay" onClick={onClose}>
			<div className="employee-form" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
				<h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>技能缺失警告</h3>
				<p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '16px' }}>
					代理 "{useAgentStore.getState().agents.find(e => e.id === employeeId)?.name || employeeId}" 引用了以下缺失的技能：
				</p>

				<div className="form-field">
					<label>缺失的技能</label>
					<div style={{ 
						maxHeight: '200px', 
						overflowY: 'auto', 
						border: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2))',
						borderRadius: '4px',
						padding: '8px'
					}}>
						{missingSkillIds.map(skillId => (
							<div key={skillId} style={{ 
								padding: '4px 8px', 
								fontSize: '12px',
								borderBottom: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.1))'
							}}>
								{skillId}
							</div>
						))}
					</div>
				</div>

				{installError && (
					<div style={{ 
						color: 'var(--vscode-errorForeground, #f87171)', 
						fontSize: '12px', 
						marginTop: '8px',
						padding: '8px',
						background: 'rgba(239, 68, 68, 0.1)',
						borderRadius: '4px'
					}}>
						安装失败: {installError}
					</div>
				)}

				<div className="form-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>取消</button>
					<button type="button" className="btn-secondary" onClick={handleIgnore}>忽略并继续</button>
					{onInstall && (
						<button
							type="button"
							className="btn-primary"
							onClick={handleInstall}
							disabled={isInstalling}
						>
							{isInstalling ? '安装中...' : '自动安装'}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
