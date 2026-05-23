/*---------------------------------------------------------------------------------------------
 *  React Error Boundary - catches rendering errors and logs details
 *--------------------------------------------------------------------------------------------*/

import React from 'react';

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
	errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<
	{ children: React.ReactNode; name: string },
	ErrorBoundaryState
> {
	constructor(props: { children: React.ReactNode; name: string }) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error(`[ErrorBoundary:${this.props.name}] Caught error:`, error);
		console.error(`[ErrorBoundary:${this.props.name}] Component stack:`, errorInfo.componentStack);
		this.setState({ errorInfo });
	}

	render() {
		if (this.state.hasError) {
			return (
				<div style={{ padding: 16, color: 'red', fontSize: 12, overflow: 'auto', maxHeight: '100%' }}>
					<div style={{ fontWeight: 'bold', marginBottom: 8 }}>
						Error in {this.props.name}:
					</div>
					<div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>
						{this.state.error?.toString()}
					</div>
					{this.state.errorInfo && (
						<details style={{ whiteSpace: 'pre-wrap', fontSize: 10, opacity: 0.7 }}>
							<summary>Component Stack</summary>
							{this.state.errorInfo.componentStack}
						</details>
					)}
					<button
						onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
						style={{ marginTop: 8, padding: '4px 8px', cursor: 'pointer' }}
					>
						Retry
					</button>
				</div>
			);
		}

		return this.props.children;
	}
}
