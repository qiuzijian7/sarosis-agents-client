/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Form (Create/Edit)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback } from 'react';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';

interface EmployeeFormProps {
	employee?: Employee;
	onClose: () => void;
}

export function EmployeeForm({ employee, onClose }: EmployeeFormProps): React.ReactElement {
	const { createEmployee, updateEmployee } = useEmployeeStore();
	const isEditing = !!employee;

	const [name, setName] = useState(employee?.name || '');
	const [role, setRole] = useState(employee?.role || '');
	const [email, setEmail] = useState(employee?.email || '');
	const [model, setModel] = useState(employee?.model || '');
	const [customPrompt, setCustomPrompt] = useState(employee?.customPrompt || '');
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = useCallback(async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !role.trim()) { return; }

		setIsSubmitting(true);
		try {
			if (isEditing && employee) {
				await updateEmployee(employee.id, { name, role, email, model, customPrompt });
			} else {
				await createEmployee({ name, role, email, model, customPrompt });
			}
			onClose();
		} catch (err) {
			console.error('Failed to save employee:', err);
		} finally {
			setIsSubmitting(false);
		}
	}, [name, role, email, model, customPrompt, isEditing, employee, createEmployee, updateEmployee, onClose]);

	return (
		<div className="employee-form-overlay" onClick={onClose}>
			<form
				className="employee-form"
				onClick={(e) => e.stopPropagation()}
				onSubmit={handleSubmit}
			>
				<h3 style={{ margin: '0 0 16px', fontSize: '14px' }}>
					{isEditing ? 'Edit Employee' : 'Create Employee'}
				</h3>

				<div className="form-field">
					<label>Name *</label>
					<input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
				</div>

				<div className="form-field">
					<label>Role *</label>
					<input type="text" value={role} onChange={(e) => setRole(e.target.value)} required placeholder="e.g. frontend-engineer" />
				</div>

				<div className="form-field">
					<label>Email</label>
					<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
				</div>

				<div className="form-field">
					<label>Model</label>
					<input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. gpt-4o" />
				</div>

				<div className="form-field">
					<label>System Prompt</label>
					<textarea
						value={customPrompt}
						onChange={(e) => setCustomPrompt(e.target.value)}
						rows={4}
						placeholder="Custom system prompt for this employee..."
					/>
				</div>

				<div className="form-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
					<button type="submit" className="btn-primary" disabled={isSubmitting || !name.trim() || !role.trim()}>
						{isSubmitting ? 'Saving...' : (isEditing ? 'Update' : 'Create')}
					</button>
				</div>
			</form>
		</div>
	);
}
