import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^\[::1\]$/,
  /\.local$/i,
  /\.internal$/i,
  /^\d+$/,
  /^0x[0-9a-f]+$/i,
]

/**
 * 工具只接受 http(s) 链接或绝对本地路径。
 * 拒绝私网/本机地址，避免模型被诱导去访问服务器内网（SSRF）。
 */
export function assertSafeInput(input: string): string {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('input is required')

  if (isHttpUrl(value)) {
    const url = new URL(value)
    if (url.username || url.password) throw new Error('URL with credentials is not allowed')
    const host = url.hostname.toLowerCase()
    if (PRIVATE_HOST.some((re) => re.test(host))) {
      throw new Error('local/private network URLs are not allowed')
    }
    return value
  }

  if (!isAbsolute(value)) {
    throw new Error('local input must be an absolute path')
  }
  if (!existsSync(value)) {
    throw new Error(`local file not found: ${value}`)
  }
  return value
}

/** 去掉上游清单里只对 DSH 有意义的行/路径，避免把服务器路径暴露给模型。 */
export function sanitizeManifest(text: string): string {
  return String(text ?? '')
    .replace(/path="[^"]*"/g, 'path="<video>"')
    .replace(/^per-cell times for verification:.*$/gm, '')
    .replace(/DSH 42px grid/g, 'vision grid')
    .replace(/\(est@(\d+)\/img, vision grid; an API host bills by pixels\)/g, '(est. $1 vision tokens/image)')
    .replace(/\s*\(DSH grid\)/g, '')
    .replace(/\bDSH grid\b/g, 'vision tokens')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '?'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  return `${m}:${String(r).padStart(2, '0')}`
}

export function humanizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.trim()
  if (/spawn .*yt-dlp.*ENOENT|cannot find yt-dlp|yt-dlp not found|no yt-dlp/i.test(text)) {
    return '我这边找不到 yt-dlp。需要先安装（Windows: `winget install yt-dlp` 或 `pip install --user -U yt-dlp`），' +
      '或者在插件配置里填好 ytdlpPath / 放进 PATH。'
  }
  if (/spawn .*ffmpeg.*ENOENT|ffmpeg: not found|ffmpeg not found/i.test(text)) {
    return '我这边找不到 ffmpeg。需要安装 ffmpeg/ffprobe，并在插件配置里填 ffmpegPath / ffprobePath。'
  }
  if (/cookies file not found/i.test(text)) {
    return '我这边没有找到 cookies 文件。需要重新导出 B 站 cookies.txt，并在插件配置里填 cookiesFile 的绝对路径。'
  }
  if (/HTTP Error 567/i.test(text)) {
    return 'B 站把我拦下来了（HTTP 567）。通常要登录 cookies，或稍后再试；匿名 360P 一般还能看。'
  }
  if (/HTTP Error 412/i.test(text)) {
    return 'B 站限流了（HTTP 412）。等几十秒再试，不要连续用同样的参数调用我。'
  }
  if (/Sign in to confirm|login required|需要登录|Please log in/i.test(text)) {
    return '这个视频要登录才能看。需要配置 cookies.txt（B 站 SESSDATA 等），否则我只能看低清、也可能没有 CC 字幕。'
  }
  if (/Unsupported URL/i.test(text)) {
    return '我这边用的 yt-dlp 还不支持这个站点。需要更新 yt-dlp，或者改用本地视频文件。'
  }
  if (/not enough disk space/i.test(text)) {
    return '我这边磁盘空间不够了。需要清理缓存目录，或调小 mediaMaxMB / 换更短的视频。'
  }
  if (/timed out|timeout/i.test(text)) {
    return '我这边下载/转写超时了。需要检查网络，或换更短的视频分段。'
  }
  return text || '我这边遇到一个没预料到的错误，但没拿到具体原因'
}

/** 简单的全局并发闸门；小服务器上避免多个 ffmpeg 同时扫片。 */
export class Semaphore {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    return () => this.release()
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next()
  }
}