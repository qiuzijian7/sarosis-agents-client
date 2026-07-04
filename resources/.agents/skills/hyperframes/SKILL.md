---
name: hyperframes
description: HTML-based video compositions, animated title cards, captioned videos, audio-reactive visuals.
activation: manual
match: ["hyperframes", "video composition", "animated title", "captioned video", "social overlay", "motion graphics", "shader transition"]
category: creative
required_tools: ["terminal"]
---

# HyperFrames

HTML is the source of truth for video. Create video compositions using HTML, CSS, and GSAP animations. The composition is an HTML file with `data-*` timing attributes, rendered frame-by-frame and encoded to MP4/WebM.

**Prerequisites**: Node.js, FFmpeg, npx

## When to Use

- User asks for a rendered video from text, a script, or a website
- Animated title cards, lower thirds, or typographic intros
- Captioned narration video (TTS + captions synced to waveform)
- Audio-reactive visuals (beat sync, spectrum bars, pulsing glow)
- Scene-to-scene transitions (crossfade, wipe, shader warp)
- Social media video overlays (animated logos, watermarks, progress bars)

## Workflow

1. Create an HTML composition file with CSS styling and animation timing
2. Add `data-*` attributes for frame timing:
   - `data-start="0s"` — when the element appears
   - `data-duration="3s"` — how long it stays
   - `data-animation="fadeIn"` — entrance animation type
3. Use CSS animations or GSAP for motion
4. Include audio/video media elements if needed (TTS narration, background music)

## Quick Template

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { margin: 0; background: #000; width: 1920px; height: 1080px; overflow: hidden; }
.title { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 72px; font-family: system-ui; }
.fade-in { animation: fadeIn 1s ease-out forwards; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
</head>
<body>
  <div class="title fade-in" data-start="0s" data-duration="5s">Hello World</div>
</body>
</html>
```

## Encoding (requires terminal)

After creating the HTML composition, render it to video:
```bash
npx @heygentech/hyperframes render composition.html -o output.mp4
```

Or with FFmpeg directly:
```bash
ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :0.0 -vframes 150 -c:v libx264 output.mp4
```

## After generating

Call `html_preview("/absolute/path/to/composition.html")` to preview the HTML composition before encoding.
