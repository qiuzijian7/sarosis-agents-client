---
name: dogfood
description: "Exploratory QA of web apps: find bugs, evidence, reports."
activation: manual
match: ["dogfood", "testing", "browser", "web"]
category: dogfood
tier: extended
---

# Dogfood: Systematic Web Application QA Testing

## Overview

Exploratory QA of a web app: navigate, interact, capture evidence, and produce a structured bug report.
All browser work goes through the single dsh-side `browser` tool. Skills and tools live on the dsh
side — do not call any per-action browser tool family.

## Prerequisites

- The dsh-side `browser` tool (one tool, actions selected by `op`). It drives the user's real Chrome
  via CDP, so the login state is already available. Common ops: status, navigate, snapshot, click,
  type, pressKey, scroll, back, find, waitFor, evaluate, screenshot.
- A target URL and a testing scope from the user.

## Inputs

The user provides:
1. **Target URL** — the entry point for testing
2. **Scope** — areas/features to focus on (or "full site" for comprehensive testing)
3. **Output directory** (optional) — where the report goes (default: `./dogfood-output`)

## Workflow

Follow this 5-phase systematic workflow:

### Phase 1: Plan

1. Create the output directory structure:
   ```
   {output_dir}/
   ├── screenshots/       # Evidence screenshots (when the Host can persist attachments)
   └── report.md          # Final report (generated in Phase 5)
   ```
2. Identify the testing scope based on user input.
3. Build a rough sitemap by planning which pages and features to test:
   - Landing/home page
   - Navigation links (header, footer, sidebar)
   - Key user flows (sign up, login, search, checkout, etc.)
   - Forms and interactive elements
   - Edge cases (empty states, error pages, 404s)

### Phase 2: Explore

For each page or feature in your plan:

1. **Navigate** to the page:
   ```
   browser(op="navigate", url="https://example.com/page")
   ```

2. **Take a snapshot** to read the page structure and collect element refs:
   ```
   browser(op="snapshot")
   ```
   Refs from the snapshot (`@eN`) are what the click/type ops consume.

3. **Look at the screen**:
   ```
   browser(op="screenshot")
   ```
   The screenshot comes back as an image attachment in the tool result (JPEG). Text snapshots
   cannot show broken layout, overlap, colour problems or clipped text — use the image for those.

4. **Test interactive elements** systematically:
   ```
   browser(op="click", ref="@eN")
   browser(op="type", ref="@eN", text="test input")
   browser(op="pressKey", key="Tab")
   browser(op="pressKey", key="Enter")
   browser(op="scroll", direction="down")
   browser(op="back")
   browser(op="waitFor", textGone="Loading...")
   ```
   Test form validation with invalid inputs and empty submissions.

5. **After each interaction**, check:
   - `browser(op="snapshot")` — did the expected state appear?
   - `browser(op="screenshot")` — did anything shift, overlap or overflow?
   - Expected vs actual behaviour.

**Console errors**: the dsh `browser` tool has no console-reading op. Do not claim console errors were
checked. Look for visible error banners in the snapshot/screenshot instead, and record
"console errors: not collected" in the report. This is an honest capability gap, not a pass.

### Phase 3: Collect Evidence

For every issue found:

1. **Capture the screen** while the issue is visible:
   ```
   browser(op="screenshot", fullPage=true)
   ```
   The image is returned as a tool-result attachment, not a file path. Record the step id, URL and
   whether the attachment was returned. If the Host has no attachment service, write
   "screenshot unavailable" — never invent a path.

2. **Record the details**:
   - URL where the issue occurs
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Visible error text (console errors: not collected)
   - Screenshot attachment reference

3. **Classify the issue** using the issue taxonomy (see `references/issue-taxonomy.md`):
   - Severity: Critical / High / Medium / Low
   - Category: Functional / Visual / Accessibility / Console / UX / Content

### Phase 4: Categorize

1. Review all collected issues.
2. De-duplicate — merge issues that are the same bug manifesting in different places.
3. Assign final severity and category to each issue.
4. Sort by severity (Critical first, then High, Medium, Low).
5. Count issues by severity and category for the executive summary.

### Phase 5: Report

Generate the final report using the template at `templates/dogfood-report-template.md`.

The report must include:
1. **Executive summary** with total issue count, breakdown by severity, and testing scope
2. **Per-issue sections** with:
   - Issue number and title
   - Severity and category badges
   - URL where observed
   - Description of the issue
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshot attachment reference (or "screenshot unavailable")
   - Visible error text, if any
3. **Summary table** of all issues
4. **Testing notes** — what was tested, what was not, and the console-collection gap

Save the report to `{output_dir}/report.md`.

## Tools Reference

| Call | Purpose |
|------|---------|
| `browser` op=status | Check that a page is attached |
| `browser` op=navigate | Go to a URL |
| `browser` op=snapshot | Text snapshot + element refs |
| `browser` op=screenshot | Screenshot as an image attachment (fullPage/quality supported) |
| `browser` op=click / type | Interact by ref or text |
| `browser` op=pressKey / scroll / back | Keyboard, scrolling, history |
| `browser` op=find / waitFor | Locate text, wait for a condition |
| `browser` op=evaluate | Read DOM/computed state for a geometric assertion |

## Tips

- Every correctness claim needs either a snapshot observation or a machine-checkable value from
  `browser(op="evaluate")`; a screenshot alone is an observation, not a pass verdict.
- Test with both valid and invalid inputs — form validation bugs are common.
- Scroll through long pages — content below the fold may have rendering issues.
- Test navigation flows — click through multi-step processes end-to-end.
- Check responsive behaviour by noting any layout issues visible in screenshots.
- Don't forget edge cases: empty states, very long text, special characters, rapid clicking.
