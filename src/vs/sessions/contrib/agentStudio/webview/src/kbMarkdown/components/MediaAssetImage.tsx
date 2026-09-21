/* 媒体库引用图片（同源化方案 B/C 的渲染层）：
 *  - src 为 `saros-media://<id>` ⇒ 经宿主桥解析为可加载 URL（方案 B，零复制引用）；
 *  - 图片上提供「保存到笔记」按钮 ⇒ 宿主复制进 <note>.attachments/ 并回报相对引用，
 *    由上层替换正文（方案 C，显式沉淀换来可移植性）；
 *  - 资产不可用/超时 ⇒ 显示占位而非裂图。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ImageComponent } from './ImageComponent';
import { mediaAssetId, resolveMediaAssetUrl, saveMediaToNote } from '../mediaAssetBridge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function MediaAssetImage(props: any): React.ReactElement {
	const { node: _node, src, alt, onSaved, ...rest } = props;
	const assetId = mediaAssetId(src as string | undefined);

	const [url, setUrl] = useState<string | null>(null);
	const [missing, setMissing] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setUrl(null);
		setMissing(false);
		if (!assetId) {
			setMissing(true);
			return undefined;
		}
		void resolveMediaAssetUrl(assetId).then((u) => {
			if (cancelled) { return; }
			if (u) { setUrl(u); } else { setMissing(true); }
		});
		return () => { cancelled = true; };
	}, [assetId]);

	const handleSave = useCallback(async () => {
		if (!assetId || saving) { return; }
		setSaving(true);
		const result = await saveMediaToNote(assetId);
		setSaving(false);
		if (result.relRef && typeof onSaved === 'function') {
			onSaved(assetId, result.relRef);
		}
	}, [assetId, saving, onSaved]);

	if (missing) {
		return (
			<span className="kb-media-missing" title={`媒体库资产不可用：${assetId ?? 'unknown'}`}>
				媒体库资产不可用
			</span>
		);
	}

	return (
		<span className="kb-media-asset">
			{url ? (
				<ImageComponent {...rest} src={url} alt={alt} />
			) : (
				<span className="kb-media-loading">加载媒体库图片…</span>
			)}
			<button
				type="button"
				className="kb-media-save"
				title="复制到笔记附件目录（此后笔记自包含、可随 vault 迁移）"
				onClick={handleSave}
				disabled={saving || !url}
			>
				{saving ? '保存中…' : '保存到笔记'}
			</button>
		</span>
	);
}
