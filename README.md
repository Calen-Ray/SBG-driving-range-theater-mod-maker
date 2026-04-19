# Theater Video Compiler

Static web app for building `DrivingRangeTheater` content packs in the browser.

## What it does

- Accepts 1-20 source videos in mixed formats
- Re-encodes each clip to `1920x1080` MP4 using H.264 High / `yuv420p`
- Extracts sidecar `.ogg` audio with the same basename when the source has audio
- Prefixes filenames numerically so the mod plays them in the chosen order
- Offers `Draft`, `Fastest`, and `Good` encoding presets
- Offers `480p`, `720p`, and `1080p` output targets, with lower resolutions usually encoding faster
- Exports a Thunderstore-style zip with `manifest.json`, `README.md`, `icon.png`, and `Videos/` at the archive root

## Local development

```bash
npm install
npm run dev
```

## Test

```bash
npm run test
```

The local suite covers:

- queue normalization and filename generation
- compatibility fallback for browsers without `crypto.randomUUID()`
- drag-and-drop queueing
- mocked end-to-end pack builds across preset selection and FFmpeg load configuration

## Build

```bash
npm run build
```

The output is written to `dist/` and is configured with a relative Vite `base`, so it can be hosted directly on GitHub Pages.

## GitHub Pages

Two workflows are included under `.github/workflows/`:

- `ci.yml` runs `npm run lint`, `npm run test`, and `npm run build` on pushes and pull requests
- `deploy-pages.yml` builds `dist/` and deploys it to GitHub Pages from `main`

After pushing to GitHub, enable Pages in the repository settings and set the source to **GitHub Actions**.

## Notes

- Processing is entirely client-side via `ffmpeg.wasm`. Large source files can use substantial RAM and take time on lower-end machines.
- The generated archive targets the format described by the adjacent `mods/DrivingRangeTheater` project:
  - video files are scanned from `Videos/`
  - alphabetical filename order determines playback order
  - sidecar audio must share the video basename
