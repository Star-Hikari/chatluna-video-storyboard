import { existsSync } from 'node:fs'
import { Context, Schema } from 'koishi'
import { BiliCookieManager } from './bili-cookie'
import { CellStore } from './cell-store'
import { Config, resolveDataDir, type Config as ConfigType } from './config'
import { probeInput, prepareEnvironment, loadUpstream } from './upstream'
import { Semaphore } from './utils'
import { VideoProbeTool } from './tools/probe'
import { VideoStoryboardTool } from './tools/storyboard'
import { VideoZoomTool } from './tools/zoom'
import type { ToolDeps } from './tools/shared'

export const name = 'chatluna-video-storyboard'
export const inject = ['chatluna']
export { Config }
export { BiliCookieManager } from './bili-cookie'
export { prepareModelImages } from './image'

export async function apply(ctx: Context, config: ConfigType) {
  const paths = await prepareEnvironment(config).catch((error) => {
    ctx.logger.warn('[chatluna-video] 无法创建数据目录，将使用默认路径：', error)
    return {
      dir: resolveDataDir(config),
      cacheDir: resolveDataDir(config),
      mediaDir: resolveDataDir(config),
    }
  })

  const cookieManager = new BiliCookieManager(ctx, config, paths.dir)
  if (cookieManager.cookieFile) {
    // 空 cookiesFile = 自动维护 dataDir/cookies.txt；同步给上游/yt-dlp。
    config.cookiesFile = cookieManager.cookieFile
    process.env.DSH_VIDEO_COOKIES = cookieManager.cookieFile
  }
  cookieManager.start()

  const deps: ToolDeps = {
    ctx,
    config,
    cellStore: new CellStore(paths.dir),
    semaphore: new Semaphore(config.maxConcurrent),
    cookieManager,
  }

  const tools = [
    new VideoProbeTool(deps),
    new VideoStoryboardTool(deps),
    new VideoZoomTool(deps),
  ]

  for (const tool of tools) {
    ctx.effect(() =>
      ctx.chatluna.platform.registerTool(tool.name, {
        description: tool.description,
        selector: () => true,
        authorization: (session) => {
          if (!config.allowedGroups?.length) return true
          if (!session?.guildId) return true
          return config.allowedGroups.map(String).includes(String(session.guildId))
        },
        meta: {
          source: 'extension',
          group: 'chatluna-video',
          tags: ['video', 'storyboard'],
          defaultAvailability: {
            enabled: true,
            main: true,
            subAgent: false,
            chatluna: true,
            characterScope: 'all',
          },
        },
        createTool: () => tool,
      }),
    )
  }

  ctx.logger.info(
    `[chatluna-video] registered ${tools.length} tools; data=${paths.dir} ` +
    `asr=${config.asrEnabled ? 'on' : 'off'} maxDuration=${config.maxDurationSec}s`,
  )

  ctx.on('ready', () => {
    void doctor(ctx, config).catch((error) => {
      ctx.logger.warn('[chatluna-video] 自检失败：', error)
    })
  })
}

/**
 * 启动自检只写日志、不阻塞插件加载。
 * 真正的错误仍会在工具调用时以可操作文案返回。
 */
async function doctor(ctx: Context, config: ConfigType) {
  const warn = (message: string) => ctx.logger.warn(`[chatluna-video] ${message}`)
  const info = (message: string) => ctx.logger.info(`[chatluna-video] ${message}`)

  try {
    const { ytdlp } = await loadUpstream()
    const ffmpeg = await ytdlp.runProcess(
      { bin: config.ffmpegPath, prefix: [] },
      ['-version'],
      { timeoutMs: 10_000 },
    )
    if (ffmpeg.code !== 0) warn(`ffmpeg 不可用（${config.ffmpegPath}）；视频工具会失败。`)
    else info(`ffmpeg ok: ${ffmpeg.stdout.split(/\r?\n/)[0]}`)

    const ffprobe = await ytdlp.runProcess(
      { bin: config.ffprobePath, prefix: [] },
      ['-version'],
      { timeoutMs: 10_000 },
    )
    if (ffprobe.code !== 0) warn(`ffprobe 不可用（${config.ffprobePath}）；probe/storyboard 会失败。`)
  } catch (error) {
    warn(`ffmpeg/ffprobe 自检失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const { ytdlp } = await loadUpstream()
    const tool = config.ytdlpPath
      ? { bin: config.ytdlpPath, prefix: [] as string[] }
      : await ytdlp.discoverYtdlp({ env: process.env })
    const result = await ytdlp.runProcess(tool, ['--version'], { timeoutMs: 15_000 })
    if (result.code !== 0) warn('yt-dlp 不可用；B 站/网页链接会失败，本地文件不受影响。')
    else info(`yt-dlp ok: ${result.stdout.trim()}`)
  } catch {
    warn('未找到 yt-dlp。请安装（winget install yt-dlp / pip install --user -U yt-dlp），' +
      '或在插件配置里填写 ytdlpPath；本地文件仍可用。')
  }

  if (config.biliLoginEnabled) {
    if (config.cookiesFile && existsSync(config.cookiesFile)) {
      info(`使用 cookies 文件：${config.cookiesFile}（有效性由登录管理器检查）`)
    } else {
      info(`未找到 cookies；已开始扫码登录，成功后自动写入 ${config.cookiesFile || 'dataDir/cookies.txt'}`)
    }
  } else if (config.cookiesFile && !existsSync(config.cookiesFile)) {
    warn(`cookies 文件不存在：${config.cookiesFile}；B 站 1080P/CC 字幕会退回匿名/缺失。`)
  } else if (!config.cookiesFile) {
    info('自动登录已关闭且未配置 cookies；匿名通常只能拿到 360/480P，且没有 CC 字幕。')
  }

  if (!config.asrEnabled) {
    info('ASR 已关闭，只出画面。')
  } else if (/openspeech\.bytedance\.com\/api\/v3\/auc\/bigmodel\/submit/i.test(config.asrBaseUrl)) {
    warn('当前 asrBaseUrl 是火山 BigModel 的 submit 接口，不是 OpenAI 兼容的 /audio/transcriptions 端点；' +
      '插件会请求 .../submit/audio/transcriptions 并得到 404。请换成 OpenAI 兼容端点（SiliconFlow / 本地 FunASR）。')
  } else if (!config.asrApiKey && !/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])/i.test(config.asrBaseUrl)) {
    warn('ASR 已开启，但云端端点没有 API Key；没有站点 CC 的视频将没有台词。' +
      '可填写 asrApiKey，或把 asrBaseUrl 指向本地 ASR 服务。')
  } else {
    info(`ASR 已配置：${config.asrBaseUrl} · ${config.asrModel}`);
  }

  // 提前加载一次，避免第一次工具调用才发现上游包缺失。
  try {
    await loadUpstream()
    info('上游 dsh-video-storyboard-patched 加载成功。')
  } catch (error) {
    warn(`上游 dsh-video-storyboard-patched 加载失败：${error instanceof Error ? error.message : String(error)}`)
  }
}