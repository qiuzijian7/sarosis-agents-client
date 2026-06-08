/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Question Carousel Card Component
 *
 *  Displays suggested questions that user can click to send
 *  Mirrors VS Code's chatQuestionCarouselPart.ts pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useState } from 'react';

export interface SuggestedQuestion {
	id: string;
	label: string;
	tooltip?: string;
	category?: string;
}

interface QuestionCarouselCardProps {
	questions: SuggestedQuestion[];
	title?: string;
	onQuestionClick?: (question: SuggestedQuestion) => void;
	showCategories?: boolean;
}

export const QuestionCarouselCard = memo(function QuestionCarouselCard({
	questions,
	title = '推荐问题',
	onQuestionClick,
	showCategories = false,
}: QuestionCarouselCardProps): React.ReactElement {
	const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

	if (!questions || questions.length === 0) { return <></>; }

	const categories = showCategories
		? Array.from(new Set(questions.map(q => q.category).filter(Boolean)))
		: [];

	const filteredQuestions = selectedCategory
		? questions.filter(q => q.category === selectedCategory)
		: questions;

	const handleClick = (question: SuggestedQuestion) => {
		onQuestionClick?.(question);
	};

	return (
		<div className="question-carousel-card">
			{title && (
				<div className="question-carousel-title">
					<span className="question-carousel-icon">💬</span>
					<span>{title}</span>
				</div>
			)}
			{categories.length > 0 && (
				<div className="question-carousel-categories">
					<button
						className={`category-btn ${selectedCategory === null ? 'active' : ''}`}
						onClick={() => setSelectedCategory(null)}
					>
						全部
					</button>
					{categories.map(cat => (
						<button
							key={cat}
							className={`category-btn ${selectedCategory === cat ? 'active' : ''}`}
							onClick={() => setSelectedCategory(cat ?? null)}
						>
							{cat}
						</button>
					))}
				</div>
			)}
			<div className="question-carousel-list">
				{filteredQuestions.map((q) => (
					<button
						key={q.id}
						className="question-carousel-item"
						title={q.tooltip}
						onClick={() => handleClick(q)}
					>
						<span className="question-label">{q.label}</span>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<line x1="5" y1="12" x2="19" y2="12" />
							<polyline points="12 5 19 12 12 19" />
						</svg>
					</button>
				))}
			</div>
		</div>
	);
});
