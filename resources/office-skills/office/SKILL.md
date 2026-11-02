---
name: office
description: Create, edit, inspect, or convert Office documents, spreadsheets, presentations, and PDFs. Load to choose the relevant workflow.
---

# Office task routing

Call the `skill` tool with the format skill name before creating, reading, or editing Office files. Standalone rendering, PDF export, and recalculation need only their operation skill.

- Create, read, or edit: `office-docx` (Word), `office-pptx` (PowerPoint), or `office-xlsx` (Excel).
- Images, visual inspection, or tasks primarily about layout, spacing, sizing, or alignment: `office-render`, even without an explicit visual-check request.
- Refresh spreadsheet formula results: `office-recalculate`.
- Export an Office file to PDF: `office-export-pdf`.

Honor requests to skip rendering. New files, content edits, formulas, and incidental formatting such as bold headers or number formats need no render unless visual inspection is requested. Do not reload skills.

## This deployment's runtime

- **Python**: take the absolute interpreter from `load_workspace_dependencies` (a read-only payload that
  ships with the product). Never `pip install`, never fall back to a system Python, and never assume a
  library exists — report the missing piece instead of working around it.
- **LibreOffice Kit**: bundled with the product. The `## Installed LibreOffice Kit` section that the
  operation skills append carries the authoritative Node + CLI paths. Never download, `npx`, or
  substitute another engine; if invoking it fails, report the failure.
- **Delivery**: hand over the final file with `present`, and also state its absolute path in the reply —
  the document-preview sidebar is disabled in this deployment, so the path is how the user finds the file
  outside the delivery card.
- **Hand-assembling OOXML**: do **not** use PowerShell `Compress-Archive` — its ZIP entries can contain
  backslashes and Office then fails to open or preview the file. Use Python `zipfile` with forward-slash
  entry names.
- **Word templates**: when the user wants the layout of their own `.docx` reused, use the
  `office-template` skill (paragraph-level IDs + native layout retention) instead of rebuilding the
  document from scratch.
