# Third-party notices

This plugin depends on the following third-party packages. Their licenses
remain with their respective authors; this file is attribution only.

## dsh-video-storyboard-patched

- Based on: `dsh-video-storyboard` by SAOS-3624
- Upstream: https://github.com/SAOS-3624/dsh-video-storyboard
- License: Apache-2.0
- Local patches: Bilibili AI-subtitle detection, ASR fallback, and MiMo ASR
  support. The patched package is published separately as
  `dsh-video-storyboard-patched`; its npm tarball includes the upstream
  `LICENSE`, `NOTICE`, and `CREDITS.md` files.

## qrcode-terminal

- Author: Gord Tanner and contributors
- Upstream: https://github.com/gtanner/qrcode-terminal
- License: Apache-2.0

## Runtime tools and services (not bundled)

- FFmpeg / ffprobe: LGPL-2.1-or-later or GPL, depending on the build; installed
  by the user and invoked as a separate process.
- yt-dlp: Unlicense; installed by the user.
- ASR services and models (SiliconFlow, MiMo, local FunASR/sherpa, etc.) are
  configured by the user and are not redistributed by this plugin.

The plugin code itself is MIT-licensed; see `LICENSE`.