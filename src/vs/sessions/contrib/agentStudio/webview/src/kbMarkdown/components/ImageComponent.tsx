import { useState, type ComponentPropsWithoutRef } from 'react';
import { isRelativeLocalHref } from '../relativePath';

interface IImageComponentProps extends ComponentPropsWithoutRef<'img'> {
	/**
	 * **未拼接 assetBaseUri** 的原始 src（如 `assets/x.png` / `x.png`）。
	 *
	 * ★ 2026-09-24（用户要求「知识库中的 png/svg 图片要在 editorPane 中显示」）：
	 * 「在编辑器窗格打开」要的是**本地相对路径**（宿主按 note 目录解析后交给编辑器 resolver），
	 * 而渲染用的 `src` 已被 `resolveAssetSrc` 拼成 `asWebviewUri` 的远程形态，无法反推。
	 */
	rawSrc?: string;
	/** 在编辑器窗格中打开该图片（宿主按扩展名路由到 KbMediaViewerPane 的图片预览）。 */
	onOpenInEditor?: (href: string) => void;
}

export function ImageComponent(props: IImageComponentProps): React.ReactElement {
	const { node: _node, rawSrc, onOpenInEditor, ...rest } = props;
	const [open, setOpen] = useState(false);
	const src = rest.src as string | undefined;
	// 只对**本地相对路径**提供入口：http/https/data 等交给浏览器/不需要编辑器窗格
	const openable = !!rawSrc && !!onOpenInEditor && isRelativeLocalHref(rawSrc);

	return (
		<>
			<img
				{...rest}
				style={{ cursor: 'zoom-in', maxWidth: '100%', ...(rest.style || {}) }}
				onClick={() => setOpen(true)}
			/>
			{open && (
				<div className="kb-lightbox" onClick={() => setOpen(false)}>
					{/* 工具条：阻止冒泡，否则点按钮会先触发关闭 */}
					<div className="kb-lightbox-bar" onClick={(e) => e.stopPropagation()}>
						<span className="kb-lightbox-name" title={rawSrc ?? src}>
							{rawSrc ?? src ?? '图片'}
						</span>
						{openable && (
							<button
								type="button"
								className="kb-lightbox-open"
								title="在编辑器窗格中打开该图片（可缩放查看，不修改文件）"
								onClick={() => { setOpen(false); onOpenInEditor!(rawSrc!); }}
							>
								⤢ 在编辑器窗格打开
							</button>
						)}
					</div>
					{src && <img src={src} alt={rest.alt} className="kb-lightbox-img" />}
				</div>
			)}
		</>
	);
}
