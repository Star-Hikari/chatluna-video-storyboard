import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config'
import { resolveDataDir } from './config'
import { isHttpUrl } from './utils'

type PipelineModule = typeof import('dsh-video-storyboard-patched/pipeline')
type FormatModule = typeof import('dsh-video-storyboard-patched/format')
type ProbeModule = typeof import('dsh-video-storyboard-patched/probe')
type YtdlpModule = typeof import('dsh-video-storyboard-patched/ytdlp')
type BoardModule = typeof import('dsh-video-storyboard-patched/board')

export interface UpstreamModules {
  pipeline: PipelineModule
  format: FormatModule
  probe: ProbeModule
  ytdlp: YtdlpModule
  board: BoardModule
}

let cached: Promise<UpstreamModules> | null = null

export function loadUpstream(): Promise<UpstreamModules> {
  if (!cached) {
    cached = (async () => {
      const [pipeline, format, probe, ytdlp, board] = await Promise.all([
        import('dsh-video-storyboard-patched/pipeline'),
        import('dsh-video-storyboard-patched/format'),
        import('dsh-video-storyboard-patched/probe'),
        import('dsh-video-storyboard-patched/ytdlp'),
        import('dsh-video-storyboard-patched/board'),
      ])
      return { pipeline, format, probe, ytdlp, board }
    })()
  }
  return cached
}

export interface DataPaths {
  dir: string
  cacheDir: string
  mediaDir: string
}

/**
 * 把 Koishi 配置映射成上游认识的环境变量。
 *
 * 上游的 ASR/缓存/媒体目录只从 env 或 ~/.dsh/*.json 读，没有逐参数入口；
 * 这里在插件启动时写入一次。一个 Koishi 进程只应有一个视频插件实例，
 * 多实例会互相覆盖这些全局变量。
 */
export async function prepareEnvironment(config: Config): Promise<DataPaths> {
  const dir = resolveDataDir(config)
  const cacheDir = join(dir, 'cache')
  const mediaDir = join(dir, 'media')
  await Promise.all([
    mkdir(dir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(mediaDir, { recursive: true }),
  ])

  process.env.DSH_VIDEO_CACHE_DIR = cacheDir
  process.env.DSH_VIDEO_MEDIA_DIR = mediaDir
  process.env.DSH_VIDEO_MEDIA_MAX_MB = String(config.mediaMaxMB)
  if (config.ffmpegPath) process.env.DSH_FFMPEG_PATH = config.ffmpegPath
  if (config.ffprobePath) process.env.DSH_FFPROBE_PATH = config.ffprobePath
  if (config.ytdlpPath) process.env.DSH_YTDLP_PATH = config.ytdlpPath
  if (config.cookiesFile) process.env.DSH_VIDEO_COOKIES = config.cookiesFile

  if (config.asrEnabled) {
    process.env.DSH_ASR_BASE_URL = config.asrBaseUrl
    process.env.DSH_ASR_MODEL = config.asrModel
    process.env.DSH_ASR_LANG = config.asrLanguage
    if (config.asrApiKey) process.env.DSH_ASR_KEY = config.asrApiKey
  }

  return { dir, cacheDir, mediaDir }
}

function cookiesArgs(config: Config): string[] {
  if (!config.cookiesFile) return []
  if (!existsSync(config.cookiesFile)) {
    throw new Error(`cookies file not found: ${config.cookiesFile}`)
  }
  return ['--cookies', config.cookiesFile]
}

async function ytdlpTool(config: Config) {
  const { ytdlp } = await loadUpstream()
  if (config.ytdlpPath) return { bin: config.ytdlpPath, prefix: [] as string[] }
  return ytdlp.discoverYtdlp({ env: process.env })
}

export function upstreamFetchOptions(config: Config) {
  return {
    ...(config.cookiesFile ? { cookies: config.cookiesFile } : {}),
    ...(config.ytdlpPath ? { ytdlp: { bin: config.ytdlpPath, prefix: [] as string[] } } : {}),
    // vendored 上游补丁：AI 字幕（ai-zh）是否改用 ASR 重跑。
    ...(config.asrOnAiSubtitle ? { preferAsrOverAiSubtitle: true } : {}),
  }
}

export async function runStoryboardWithConfig(
  config: Config,
  options: import('dsh-video-storyboard-patched/pipeline').StoryboardOptions,
) {
  const { pipeline } = await loadUpstream()
  return pipeline.runStoryboard({
    ...options,
    ffmpegPath: config.ffmpegPath || 'ffmpeg',
    ffprobePath: config.ffprobePath || 'ffprobe',
    frameConcurrency: options.frameConcurrency ?? config.frameConcurrency,
    fetchOptions: {
      ...(options.fetchOptions ?? {}),
      ...upstreamFetchOptions(config),
    },
    // 显式传 key：空字符串表示“本次没有 key”，不要回退到 ~/.dsh/asr.json。
    asrKey: config.asrEnabled ? config.asrApiKey : '',
    ...(config.asrEnabled ? {} : { transcript: 'off' as const }),
    ...(options.hotwords === undefined && config.asrHotwords
      ? { hotwords: config.asrHotwords }
      : {}),
    // OCR 需要 Python 侧依赖；MVP 默认关闭，避免服务器上少装东西就静默失败。
    ocr: false,
  })
}

export interface ProbeResult {
  kind: 'local' | 'url'
  text: string
  duration: number
  info?: any
  remote?: any
}

/** 只读元信息：本地走 ffprobe；URL 走 yt-dlp -J（不下载视频）。 */
export async function probeInput(config: Config, input: string): Promise<ProbeResult> {
  const { format, probe, ytdlp } = await loadUpstream()

  if (!isHttpUrl(input)) {
    const info = {
      ...(await probe.probeVideo(input, { ffprobePath: config.ffprobePath || 'ffprobe' })),
      path: input,
    }
    return {
      kind: 'local',
      text: await format.formatProbe(info),
      duration: Number(info?.duration) || 0,
      info,
    }
  }

  const tool = await ytdlpTool(config)
  const args = ['-J', '--no-warnings', '--no-playlist', ...cookiesArgs(config), input]
  const result = await ytdlp.runProcess(tool, args, { timeoutMs: 90_000 })
  if (result.code !== 0) {
    throw new Error(ytdlp.explainYtdlpError(result.stderr, result.code))
  }

  let info: any
  try {
    info = JSON.parse(result.stdout)
  } catch {
    throw new Error('yt-dlp returned unparsable JSON while probing this link')
  }
  const single = ytdlp.unwrapSingle(info, input)
  const summary = ytdlp.summariseInfo(single)
  const remote = {
    url: input,
    title: summary.title,
    duration: summary.duration,
    heights: summary.heights,
    maxHeight: summary.maxHeight,
    auth: config.cookiesFile ? 'cookies' : 'anonymous',
    ...(Array.isArray(summary.loginGates) && summary.loginGates.length > 0
      ? { needLogin: summary.loginGates }
      : {}),
  }

  return {
    kind: 'url',
    text: format.formatRemoteProbe(remote),
    duration: Number(summary.duration) || 0,
    remote,
  }
}

/**
 * zoom 用：拿一条 1080P 直链，只按帧读取，不落盘。
 * 失败返回 null，交给上游回退到本地扫描副本。
 */
export async function resolveDirectVideoUrl(
  config: Config,
  input: string,
  height = 1080,
): Promise<{ uri: string; height: number; userAgent: string; referer: string } | null> {
  if (!isHttpUrl(input)) return null
  try {
    const { ytdlp } = await loadUpstream()
    const tool = await ytdlpTool(config)
    const args = [
      '-g',
      '-f',
      `bv*[height<=${height}]/b[height<=${height}]`,
      '--no-warnings',
      '--no-playlist',
      ...cookiesArgs(config),
      input,
    ]
    const result = await ytdlp.runProcess(tool, args, { timeoutMs: 60_000 })
    if (result.code !== 0) return null
    const uri = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (!uri) return null

    let referer = 'https://www.bilibili.com/'
    try {
      const url = new URL(input)
      if (!/(^|\.)bilibili\.com$|(^|\.)b23\.tv$/i.test(url.hostname)) {
        referer = `${url.protocol}//${url.host}/`
      }
    } catch {
      /* 用默认 referer */
    }

    return { uri, height, userAgent: ytdlp.DEFAULT_UA, referer }
  } catch {
    return null
  }
}