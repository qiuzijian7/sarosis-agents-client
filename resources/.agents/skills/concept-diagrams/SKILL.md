---
name: concept-diagrams
description: Flat, minimal light/dark SVG diagrams as HTML — physics, chemistry, math, engineering visuals.
activation: manual
match: ["concept-diagrams", "educational diagram", "svg diagram", "physics diagram", "chemistry diagram"]
category: creative
---

# Concept Diagrams

Generate production-quality SVG diagrams with a unified flat, minimal design system. Output is a single self-contained HTML file with inline SVG. Identical rendering in any browser, automatic light/dark mode.

## Scope

**Best suited for:**
- Physics setups, chemistry mechanisms, math curves
- Physical objects (aircraft, turbines, smartphones, mechanical watches)
- Anatomy, cross-sections, exploded layer views
- Floor plans, architectural conversions
- Narrative journeys (lifecycle of X, process of Y)
- Hub-spoke system integrations (smart city, IoT networks)
- Educational / textbook-style visuals
- Quantitative charts (grouped bars, energy profiles)

**8 chart types**: Flowchart, Structural/Containment, API/Endpoint Map, Microservice Topology, Data Flow, Physical/Structural, Infrastructure/Systems Integration, UI/Dashboard Mockups

## Design System

- **Colors**: 9 semantic color ramps. Light: pastel backgrounds + filled shapes. Dark: glowing neon accents.
- **Typography**: Sentence case, no all-caps. Title 18-24px, label 13px, annotation 11px.
- **Layout**: Flat 2D with isometric depth. Group with soft rounded rectangles (rx=8-16).
- **No external fonts**: Use system-ui, -apple-system.

## Workflow

1. Design the diagram structure
2. Write a single self-contained `.html` file with inline SVG elements and embedded `<style>` block
3. Include both light and dark mode styles using `@media (prefers-color-scheme: dark)`
4. After saving, call `html_preview(path)` to view the rendered result

## Quick Start Template

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Concept Diagram</title>
<style>
:root { --bg: #fff; --text: #1a1a1a; --accent: #4f46e5; --surface: #f3f4f6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1117; --text: #e4e7ec; --accent: #818cf8; --surface: #1a1d27; }
}
body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 40px; }
svg { max-width: 100%; }
</style>
</head>
<body>
<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
  <!-- Your diagram elements here -->
</svg>
</body>
</html>
```

## After generating

Call `html_preview("/absolute/path/to/diagram.html")` to preview in the editor.
