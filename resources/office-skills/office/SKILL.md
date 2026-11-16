---
name: office
description: Create or edit Office files; inspect Office files and PDFs. Load before rendering, conversion, or recalculation to enable office_render, office_convert, and office_recalculate next step.
---

# Office task routing

Load `office-docx`, `office-pptx`, or `office-xlsx` to create, read, or edit; operations alone need no format skill.

If `office_render`, `office_convert`, or `office_recalculate` is not in your tools, load `office` with `skill`; they appear next step.

- `office_render`: Office or PDF images, visual checks, and appearance or slide checks required by the format skill; skip it when asked.
- `office_recalculate`: formulas, with `format: "xlsx"` or `"ods"`.
- `office_convert` with `format`; Office inputs only, not PDFs. For PDF export alone, check the copy is nonempty and starts with `%PDF-`, then deliver it without rendering.

Copy temporary outputs to the destination, keeping existing files unless asked to replace them. Reuse loaded skills.

## This deployment's runtime

- **Python**: take the absolute interpreter from `load_workspace_dependencies` (a read-only payload that
  ships with the product). Never `pip install`, never fall back to a system Python, and never assume a
  library exists — report the missing piece instead of working around it.
- **LibreOffice Kit**: bundled with the product (it ships inside `dsh-runtime`). `office_render`,
  `office_convert`, and `office_recalculate` come from `@deepseek-ai/dsh-skill-office` and use that
  engine. Never download, `npx`, or substitute another engine; if a tool fails, report the failure.
- **Delivery**: hand over the final file with `present`, and also state its absolute path in the reply —
  the document-preview sidebar is disabled in this deployment, so the path is how the user finds the file
  outside the delivery card.
- **Hand-assembling OOXML**: do **not** use PowerShell `Compress-Archive` — its ZIP entries can contain
  backslashes and Office then fails to open or preview the file. Use Python `zipfile` with forward-slash
  entry names.
- **Word templates**: when the user wants the layout of their own `.docx` reused, use the
  `office-template` skill (paragraph-level IDs + native layout retention) instead of rebuilding the
  document from scratch.
