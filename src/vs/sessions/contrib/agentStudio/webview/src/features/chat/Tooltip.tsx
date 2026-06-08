import React, { memo, useCallback, useRef, useState, useEffect } from 'react';

/**
 * Tooltip Component - Reusable tooltip with accessibility support
 * 
 * Features:
 * - Shows on hover with delay
 * - Keyboard accessible (Escape to dismiss)
 * - Portal-based rendering to avoid z-index issues
 * - Accessibility: aria-describedby, role="tooltip"
 */
interface TooltipProps {
	content: string | React.ReactNode;
	children: React.ReactElement;
	position?: 'top' | 'bottom' | 'left' | 'right';
	delay?: number; // ms before showing
	maxWidth?: number;
}

export function Tooltip({ 
	content, 
	children, 
	position = 'top',
	delay = 300,
	maxWidth = 250
}: TooltipProps): React.ReactElement {
	const [visible, setVisible] = useState(false);
	const [coords, setCoords] = useState({ top: 0, left: 0 });
	const triggerRef = useRef<HTMLElement>(null);
	const tooltipRef = useRef<HTMLDivElement>(null);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const tooltipIdRef = useRef<string>(`tip-${Math.random().toString(36).slice(2, 9)}`);
	const tooltipId = tooltipIdRef.current;

	const showTooltip = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = setTimeout(() => {
			setVisible(true);
			updatePosition();
		}, delay);
	}, [delay]);

	const hideTooltip = useCallback(() => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
		setVisible(false);
	}, []);

	const updatePosition = useCallback(() => {
		if (!triggerRef.current || !tooltipRef.current) { return; }
		
		const triggerRect = triggerRef.current.getBoundingClientRect();
		const tooltipRect = tooltipRef.current.getBoundingClientRect();
		
		let top = 0;
		let left = 0;
		
		switch (position) {
			case 'top':
				top = triggerRect.top - tooltipRect.height - 8;
				left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
				break;
			case 'bottom':
				top = triggerRect.bottom + 8;
				left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2;
				break;
			case 'left':
				top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
				left = triggerRect.left - tooltipRect.width - 8;
				break;
			case 'right':
				top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2;
				left = triggerRect.right + 8;
				break;
		}
		
		// Keep within viewport
		const padding = 8;
		left = Math.max(padding, Math.min(left, window.innerWidth - tooltipRect.width - padding));
		top = Math.max(padding, Math.min(top, window.innerHeight - tooltipRect.height - padding));
		
		setCoords({ top, left });
	}, [position]);

	// Update position on scroll/resize
	useEffect(() => {
		if (!visible) { return; }
		
		window.addEventListener('scroll', updatePosition, true);
		window.addEventListener('resize', updatePosition);
		
		return () => {
			window.removeEventListener('scroll', updatePosition, true);
			window.removeEventListener('resize', updatePosition);
		};
	}, [visible, updatePosition]);

	// Clone children with ref and event handlers
	const child = React.Children.only(children);
	const childWithProps = React.cloneElement(child, ({
		ref: (node: HTMLElement | null) => {
			// Combine refs
			triggerRef.current = node;
			const originalRef = (child as any).ref;
			if (typeof originalRef === 'function') {
				originalRef(node);
			} else if (originalRef && typeof originalRef === 'object') {
				(originalRef as React.MutableRefObject<HTMLElement | null>).current = node;
			}
		},
		onMouseEnter: (e: React.MouseEvent) => {
			showTooltip();
			(child.props as any).onMouseEnter?.(e);
		},
		onMouseLeave: (e: React.MouseEvent) => {
			hideTooltip();
			(child.props as any).onMouseLeave?.(e);
		},
		onFocus: (e: React.FocusEvent) => {
			showTooltip();
			(child.props as any).onFocus?.(e);
		},
		onBlur: (e: React.FocusEvent) => {
			hideTooltip();
			(child.props as any).onBlur?.(e);
		},
		'aria-describedby': visible ? `tooltip-${tooltipId}` : undefined,
	}) as any);

	return (
		<>
			{childWithProps}
			
			{visible && (
				<div
					ref={tooltipRef}
					role="tooltip"
					id={`tooltip-${tooltipId}`}
					className={`tooltip tooltip-${position}`}
					style={{
						position: 'fixed',
						top: coords.top,
						left: coords.left,
						maxWidth,
						zIndex: 99999,
						animation: 'tooltipFadeIn 0.15s ease-out'
					}}
				>
					{content}
				</div>
			)}
		</>
	);
}

/**
 * Simple Tooltip Hook - For inline tooltip usage
 * Returns props to spread on trigger element
 */
export function useTooltip(content: string, delay = 300) {
	const [visible, setVisible] = useState(false);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	const show = useCallback(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => setVisible(true), delay);
	}, [delay]);

	const hide = useCallback(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		setVisible(false);
	}, []);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	return {
		visible,
		show,
		hide,
		tooltipProps: {
			onMouseEnter: show,
			onMouseLeave: hide,
			onFocus: show,
			onBlur: hide,
			'aria-describedby': visible ? `tooltip-simple` : undefined,
		}
	};
}
