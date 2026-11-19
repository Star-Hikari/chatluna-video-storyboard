import { Schema } from 'koishi'
import { resolve } from 'node:path'

export type StoryboardStrategy = 'auto' | 'compact' | 'standard' | 'full'
export type ZoomStrategy = 'full' | 'standard' | 'compact'

export interface Config {
  // ---- 外部程序 ----
  ffmpegPath: string
  ffprobePath: string
  ytdlpPath: string
  cookiesFile: string

  // ---- 存储与限制 ----
  dataDir: string
  mediaMaxMB: number
  maxDurationSec: number
  /** @deprecated 1.0.x：仅用于升级迁移，2.0.0 不再生效 */
  maxCells?: number
  /** @deprecated 1.0.x：仅用于升级迁移，2.0.0 不再生效 */
  maxZoomCells?: number
  storyboardStrategy: StoryboardStrategy
  maxFrames: number
  maxSheets: number
  storyboardBudget: number
  zoomMaxFrames: number
  zoomMaxSheets: number
  zoomStrategy: ZoomStrategy
  maxConcurrent: number
  frameConcurrency: number

  // ---- 交互与图片 ----
  progress: boolean
  sendSheetToChat: boolean
  imageModel: string
  advancedImage: boolean
  imageMaxEdge: number
  imageQuality: number
  maxRequestImageMB: number
  maxImagesPerRequest: number

  // ---- 权限与调试 ----
  allowedGroups: string[]
  debug: boolean

  // ---- B 站登录 ----
  biliLoginEnabled: boolean
  biliCookieCheckMinutes: number
  biliQrTimeoutSec: number
  biliQrMaxRefresh: number
  biliRefreshToken: boolean

  // ---- ASR（OpenAI /audio/transcriptions 或 MiMo /chat/completions）----
  asrEnabled: boolean
  asrOnAiSubtitle: boolean
  asrBaseUrl: string
  asrApiKey: string
  asrModel: string
  asrLanguage: string
  asrHotwords: string
}

const DependencyConfig = Schema.object({
  ffmpegPath: Schema.string()
    .default('ffmpeg')
    .description('ffmpeg 可执行文件。服务器上通常填 `ffmpeg`（在 PATH 中），也可填绝对路径。'),
  ffprobePath: Schema.string()
    .default('ffprobe')
    .description('ffprobe 可执行文件，通常与 ffmpeg 同目录。'),
  ytdlpPath: Schema.string()
    .default('')
    .description('yt-dlp 可执行文件；留空则自动在 PATH 与 pip 脚本目录中查找。'),
}).description('运行依赖')

const StorageConfig = Schema.object({
  dataDir: Schema.string()
    .default('data/chatluna-video')
    .description('缓存、媒体与格子表目录。相对路径基于 Koishi 工作目录。'),
  mediaMaxMB: Schema.number()
    .default(300)
    .min(50)
    .max(10240)
    .description('下载视频缓存上限（MB）。超限按最久未使用删除整段缓存。'),
  maxDurationSec: Schema.number()
    .default(600)
    .min(30)
    .max(7200)
    .description('单次 storyboard 允许处理的最大时长（秒）。超过则要求 from/segment 分段；默认 10 分钟。'),
  maxCells: Schema.number()
    .min(1)
    .max(16)
    .hidden()
    .description('已弃用（1.0.x）：旧版单张宫格最多几格。2.0.0 会自动迁移到 maxFrames/maxSheets。'),
  maxZoomCells: Schema.number()
    .min(1)
    .max(9)
    .hidden()
    .description('已弃用（1.0.x）：旧版 zoom 单张最多几格。2.0.0 会自动迁移到 zoomMaxFrames。'),
  storyboardStrategy: Schema.union([
    Schema.const('auto').description('自动（按密度挑最省的清晰档）'),
    Schema.const('compact').description('紧凑（更省 token）'),
    Schema.const('standard').description('标准'),
    Schema.const('full').description('清晰（格子更大、图片更多）'),
  ]).default('auto')
    .description('分镜取帧策略。auto 会按切点密度自动选择，通常最划算。'),
  maxFrames: Schema.number()
    .default(48)
    .min(0)
    .max(256)
    .description('单次最多取多少帧；0=不封顶。默认 48，长片请配合 from/segment。'),
  maxSheets: Schema.number()
    .default(2)
    .min(1)
    .max(8)
    .description('单次最多出几张分镜图。默认 2，与单轮图片注入上限对齐。'),
  storyboardBudget: Schema.number()
    .default(360000)
    .min(64000)
    .max(640000)
    .description('单张分镜图的像素预算；0.7.x 默认 360000（约 798×449 / 222 token）。'),
  zoomMaxFrames: Schema.number()
    .default(9)
    .min(1)
    .max(48)
    .description('video_zoom 单图最多取几帧；越少每格越大。'),
  zoomMaxSheets: Schema.number()
    .default(1)
    .min(1)
    .max(4)
    .description('video_zoom 最多出几张图；默认 1。'),
  zoomStrategy: Schema.union([
    Schema.const('full').description('清晰（默认）'),
    Schema.const('standard').description('标准'),
    Schema.const('compact').description('紧凑'),
  ]).default('full')
    .description('video_zoom 的取帧策略；默认 full，优先看清细节。'),
  maxConcurrent: Schema.number()
    .default(1)
    .min(1)
    .max(4)
    .description('同时最多几个视频在扫描。小服务器建议 1；4 核以上可 2。'),
  frameConcurrency: Schema.number()
    .default(2)
    .min(1)
    .max(8)
    .description('单次分镜取帧的 ffmpeg 并发数。小服务器 2 足够，过高会抢 CPU/IO。'),
}).description('存储与限制')

const BiliBase = Schema.object({
  biliLoginEnabled: Schema.boolean()
    .default(true)
    .description('启动时检查 cookies；缺失/失效时在控制台输出二维码，用 B 站手机客户端扫码登录。'),
  cookiesFile: Schema.string()
    .default('')
    .description('cookies.txt（Netscape 格式）路径。留空且开启自动登录时使用 dataDir/cookies.txt；关闭自动登录时留空=匿名读取。'),
}).description('B 站登录')

const BiliOptions = Schema.union([
  Schema.object({
    biliLoginEnabled: Schema.const(true),
    biliCookieCheckMinutes: Schema.number()
      .default(360)
      .min(15)
      .max(1440)
      .description('每隔多少分钟检查一次 cookies 是否有效/是否需要刷新。'),
    biliQrTimeoutSec: Schema.number()
      .default(180)
      .min(60)
      .max(600)
      .description('一次二维码登录的等待上限（秒）。'),
    biliQrMaxRefresh: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .description('二维码过期后最多重新生成几次。'),
    biliRefreshToken: Schema.boolean()
      .default(true)
      .description('检测到 cookie 需要刷新时，自动用 refresh_token 刷新，避免重新扫码。'),
  }).description('自动登录与刷新'),
  Schema.object({}),
])

const AsrBase = Schema.object({
  asrEnabled: Schema.boolean()
    .default(true)
    .description('是否启用台词层。关闭后只出画面；开启后优先站点 CC，其次 ASR。'),
}).description('台词 / ASR')

const AsrOptions = Schema.union([
  Schema.object({
    asrEnabled: Schema.const(true),
    asrOnAiSubtitle: Schema.boolean()
      .default(true)
      .description('B 站 AI 字幕（ai-zh）是否用 ASR 重跑。ASR 不可用、失败或空结果时自动回退 AI 字幕。'),
    asrBaseUrl: Schema.string()
      .default('https://api.siliconflow.cn/v1')
      .description('OpenAI 兼容 ASR 端点（如 SiliconFlow / 本地服务）；小米 MiMo 填 https://api.xiaomimimo.com/v1，插件会自动切换协议。'),
    asrApiKey: Schema.string()
      .role('secret')
      .default('')
      .description('ASR API Key。云端端点必填；本机端点可留空。'),
    asrModel: Schema.string()
      .default('FunAudioLLM/SenseVoiceSmall')
      .description('ASR 模型名。SiliconFlow 默认 SenseVoiceSmall；MiMo 填 mimo-v2.5-asr；本地填服务端实际模型名。'),
    asrLanguage: Schema.string()
      .default('zh')
      .description('语言代码。中文用 zh；MiMo 可留空走 auto。'),
    asrHotwords: Schema.string()
      .default('')
      .description('全局热词（空格分隔）。跨学科内容不建议写死；可留空。'),
  }).description('ASR 连接'),
  Schema.object({}),
])

const ImageBase = Schema.object({
  progress: Schema.boolean()
    .default(true)
    .description('处理较慢时在会话里发一条进度提示（解析/下载/扫描）。'),
  sendSheetToChat: Schema.boolean()
    .default(false)
    .description('是否把宫格图也发到聊天里给用户看。默认关闭，只给模型看。'),
  imageModel: Schema.dynamic('model')
    .default('无')
    .description('主模型不支持图片输入时，用这个多模态模型把宫格图转述成文字。"无"=不转述。'),
  advancedImage: Schema.boolean()
    .default(false)
    .description('显示高级图片参数（最长边、JPEG 质量、单次请求体上限等）。一般不用改。'),
}).description('交互与图片')

const ImageOptions = Schema.union([
  Schema.object({
    advancedImage: Schema.const(true).required(),
    imageMaxEdge: Schema.number()
      .default(800)
      .min(640)
      .max(1600)
      .description('注入模型前的最长边（像素）。0.7.x 画布本身最大 800px；默认 800 即可。'),
    imageQuality: Schema.number()
      .default(3)
      .min(2)
      .max(10)
      .description('JPEG 质量（ffmpeg qscale，2 最好、31 最差）。3 在可读性与体积间比较平衡。'),
    maxRequestImageMB: Schema.number()
      .default(2.5)
      .min(0.5)
      .max(10)
      .description('单次请求注入图片的 base64 总大小上限（MB）。超过会降质/缩图，仍超则只保留第一张。'),
    maxImagesPerRequest: Schema.number()
      .default(2)
      .min(1)
      .max(4)
      .description('单轮最多注入几张工具图；模型并行调用多个 zoom 时防止请求体爆炸。'),
  }).description('高级图片参数'),
  Schema.object({}),
])

const PermissionConfig = Schema.object({
  allowedGroups: Schema.array(String)
    .default([])
    .description('允许使用视频工具的群号；留空=不限制。私聊不受此限制。'),
  debug: Schema.boolean()
    .default(false)
    .description('输出更多日志（不包含 cookies / API Key）。'),
}).description('权限与调试')

function legacyInt(value: unknown, min: number, max: number): number | null {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * 1.0.x -> 2.0.0 配置迁移。
 *
 * 旧版没有 maxFrames/maxSheets，只有 maxCells/maxZoomCells。这里只在**新字段仍是默认值**时
 * 才迁移，避免覆盖用户已经手动设置的新配置；旧版本来就是单图，所以 maxSheets 固定为 1。
 * 迁移只修改内存中的 config，不写回 koishi.yml；返回的提示会由 apply() 打到日志。
 */
export function migrateLegacyConfig(config: Config): string[] {
  const notes: string[] = []
  const oldCells = legacyInt(config.maxCells, 1, 256)
  if (oldCells !== null) {
    const untouched = config.maxFrames === 48
      && config.maxSheets === 2
      && config.storyboardStrategy === 'auto'
    if (untouched) {
      config.maxFrames = oldCells
      config.maxSheets = 1
      config.storyboardStrategy = 'standard'
      notes.push(
        `检测到旧版 maxCells=${oldCells}，已迁移为 maxFrames=${oldCells} / maxSheets=1 / ` +
        'storyboardStrategy=standard（保持旧版单图行为）；请在控制台确认。',
      )
    } else {
      notes.push(
        `检测到旧版 maxCells=${oldCells}，但新的 maxFrames/maxSheets/storyboardStrategy 已设置，` +
        '保留新配置并忽略 maxCells。',
      )
    }
  }

  const oldZoomCells = legacyInt(config.maxZoomCells, 1, 48)
  if (oldZoomCells !== null) {
    const untouched = config.zoomMaxFrames === 9
      && config.zoomMaxSheets === 1
      && config.zoomStrategy === 'full'
    if (untouched) {
      config.zoomMaxFrames = oldZoomCells
      config.zoomMaxSheets = 1
      config.zoomStrategy = 'full'
      notes.push(
        `检测到旧版 maxZoomCells=${oldZoomCells}，已迁移为 zoomMaxFrames=${oldZoomCells} / ` +
        'zoomMaxSheets=1 / zoomStrategy=full。',
      )
    } else {
      notes.push(
        `检测到旧版 maxZoomCells=${oldZoomCells}，但新的 zoomMaxFrames/zoomMaxSheets/zoomStrategy ` +
        '已设置，保留新配置并忽略 maxZoomCells。',
      )
    }
  }

  return notes
}

export const Config = Schema.intersect([
  DependencyConfig,
  StorageConfig,
  BiliBase,
  BiliOptions,
  AsrBase,
  AsrOptions,
  ImageBase,
  ImageOptions,
  PermissionConfig,
]) as Schema<Config>

export function resolveDataDir(config: Config) {
  return resolve(process.cwd(), config.dataDir || 'data/chatluna-video')
}