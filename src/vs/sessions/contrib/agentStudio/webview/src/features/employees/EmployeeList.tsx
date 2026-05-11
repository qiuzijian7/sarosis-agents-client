/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee List Panel
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useEmployeeStore } from '../../store/useEmployeeStore';
import { EmployeeCard } from './EmployeeCard';

export function EmployeeList(): React.ReactElement {
	const { searchQuery, setSearchQuery, selectedEmployeeId, selectEmployee, filteredEmployees } = useEmployeeStore();
	const filtered = filteredEmployees();

	return (
		<div className="employee-list">
			{/* Search */}
			<div className="employee-search">
				<input
					type="text"
					className="search-input"
					placeholder="Search employees..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
				/>
			</div>

			{/* List */}
			<div className="employee-items">
				{filtered.map((employee) => (
					<EmployeeCard
						key={employee.id}
						employee={employee}
						isSelected={employee.id === selectedEmployeeId}
						onClick={() => selectEmployee(employee.id)}
					/>
				))}
				{filtered.length === 0 && (
					<div className="empty-state">
						{searchQuery ? 'No employees match your search' : 'No employees yet'}
					</div>
				)}
			</div>
		</div>
	);
}
