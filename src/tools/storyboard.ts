import { StructuredTool } from '@langchain/core/tools'
import { h } from 'koishi'
import { z } from 'zod'
import { prepareModelImages } from '../image'
import { buildPreface, describeWithImageModel, injectSheets, modelSupportsImage, transcriptNotice } from '../inject'
import { loadUpstream, probeInput, runStoryboardWithConfig } from '../upstream'
import { assertSafeInput, formatSeconds, isHttpUrl, sanitizeManifest } from '../utils'
import {
  clamp,
  conversationIdOf,
  createProgress,
  modelOf,
  sessionOf,
  toolFailure,
  type ToolDeps,
} from './shared'

const schema = z.object({
  input: z.string().describe('视频链接（http/https）或服务器上的绝对路径'),
  from: z.number().min(0).optional().describe('窗口起点（秒），默认 0'),
  to: z.number().min(0).optional().describe('窗口终点（秒）；不传则按 segment 或片长决定'),
  segment: z.number().int().min(30).max(1800).optional()
    .describe('只传 from 时每段长度（秒）；长片用 300'),
  maxFrames: z.number().int().min(0).max(256).optional()
    .describe('最多取多少帧；0=不封顶；默认取插件配置（48）'),
  maxSheets: z.number().int().min(1).max(8).optional()
    .describe('最多出几张分镜图；默认取插件配置（2）'),
  strategy: z.enum(['auto', 'compact', 'standard', 'full']).optional()
    .describe('取帧策略；默认取插件配置（auto）'),
  budget: z.number().int().min(64000).max(640000).optional()
    .describe('单张图像素预算；默认 360000（约 798×449）'),
  cutFloor: z.number().int().min(0).max(255).optional()
    .describe('切点灵敏度 0-255；越小切得越多，默认按素材类型'),
  scanGap: z.number().min(0).max(30).optional()
    .describe('切点近邻合并秒数；0=不合并'),
  integral: z.boolean().optional()
    .describe('长镜头按画面变化补帧；默认 true'),
  integralSeconds: z.number().min(1).max(30).optional()
    .describe('补帧采样代表的秒数 1-30；默认 6'),
  detail: z.enum(['low', 'med', 'high']).optional()
    .describe('每格台词字符数：low=60，med=120，high=400'),
})

type Input = z.infer<typeof schema>

export class VideoStoryboardTool extends StructuredTool {
  name = 'video_storyboard'
  description = [
    '我可以把一段视频变成带编号的分镜图（可能一张，也可能多张，编号跨图连续），并附上每一格的时间码和台词，这样我就能自己看到视频里发生了什么。',
    '当主人问我视频讲了什么、某个画面是什么样、某句话在第几分钟时，我会用这个能力。',
    '',
    '长视频先让我用 video_probe 看一眼，再用 from/segment 分段；每次结果末尾会告诉我下一段从哪开始。',
    '分镜图会出现在我眼前；引用时用“第 k 格（cell k，时间码）”。要看清某一格时，再让我用 video_zoom。',
    '只描述我真的看到的画面；看不清就说看不清，不要编造。',
  ].join('\n')

  schema = schema

  constructor(private readonly deps: ToolDeps) {
    super({})
  }

  async _call(input: Input, _runManager?: any, runConfig?: any): Promise<string> {
    const release = await this.deps.semaphore.acquire()
    const progress = createProgress(this.deps, sessionOf(runConfig))
    try {
      const value = assertSafeInput(input.input)
      if (isHttpUrl(value)) this.deps.cookieManager.kick()
      const config = this.deps.config
      const from = Math.max(0, Number(input.from) || 0)
      const to = input.to != null && Number.isFinite(Number(input.to)) ? Number(input.to) : undefined
      const segment = input.segment != null && Number.isFinite(Number(input.segment))
        ? Number(input.segment)
        : undefined
      const effectiveSegment = segment ?? (from > 0 && to === undefined ? 300 : undefined)

      if (to !== undefined && to <= from) {
        return `时间窗口无效：to（${to}s）必须大于 from（${from}s）。`
      }

      progress.start('正在看视频，先解析信息…')
      const probe = await probeInput(config, value)
      const duration = probe.duration || 0
      const window = to !== undefined
        ? to - from
        : effectiveSegment ?? duration

      if (window > config.maxDurationSec) {
        const hint = duration > config.maxDurationSec
          ? `这个视频约 ${formatSeconds(duration)}，超过单次上限 ${config.maxDurationSec}s。` +
            '请分段：video_storyboard({ input, from: 0, segment: 300 })，再按结果末尾的 next from 继续。'
          : `本次窗口 ${Math.round(window)}s 超过上限 ${config.maxDurationSec}s。请缩短 from/to，或使用 segment。`
        return `视频太长：${hint}`
      }

      const maxFrames = clamp(Number(input.maxFrames ?? config.maxFrames ?? 48), 0, 256)
      const maxSheets = clamp(Number(input.maxSheets ?? config.maxSheets ?? 2), 1, 8)
      const strategy = input.strategy ?? config.storyboardStrategy ?? 'auto'
      const budget = clamp(Number(input.budget ?? config.storyboardBudget ?? 360000), 64000, 640000)
      const detail = input.detail ?? 'med'
      const { format } = await loadUpstream()
      const result = await runStoryboardWithConfig(config, {
        input: value,
        from,
        ...(to !== undefined ? { to } : {}),
        ...(effectiveSegment !== undefined ? { segment: effectiveSegment } : {}),
        maxFrames,
        maxSheets,
        strategy,
        budget,
        ...(input.cutFloor !== undefined ? { cutFloor: input.cutFloor } : {}),
        ...(input.scanGap !== undefined ? { scanGap: input.scanGap } : {}),
        ...(input.integral !== undefined ? { integral: input.integral } : {}),
        ...(input.integralSeconds !== undefined ? { integralSeconds: input.integralSeconds } : {}),
        pick: 'mid',
        burn: 'index',
        audioStrip: true,
        onProgress: progress.onProgress,
      })

      const sheets = Array.isArray(result.sheets) ? result.sheets : []
      const pngs = sheets.map((sheet) => sheet.png).filter((png): png is Buffer => Buffer.isBuffer(png))
      if (pngs.length === 0) throw new Error('storyboard produced no image')
      const modelImages = await prepareModelImages(pngs, config, this.deps.ctx.logger)
      const omittedImages = Math.max(0, pngs.length - modelImages.length)
      const sheetWord = pngs.length > 1 ? '这些分镜图' : '这张分镜图'

      const text = '我刚刚看完了这段视频，下面是我自己记下的分镜清单：\n\n' +
        sanitizeManifest(format.formatForDetail(result, { detail })) + transcriptNotice(result)

      const allCells = sheets.flatMap((sheet) => sheet.cells ?? [])
      await this.deps.cellStore.save(value, result.info?.path, allCells).catch(() => {})

      const session = sessionOf(runConfig)
      if (config.sendSheetToChat && session) {
        for (const png of pngs.slice(0, 2)) {
          await session.send(h.image(png, 'image/png')).catch(() => {})
        }
      }

      const model = modelOf(runConfig)
      const conversationId = conversationIdOf(runConfig)
      const preface = buildPreface(result)
      let injected = false
      if (modelSupportsImage(model)) {
        injected = await injectSheets(this.deps.ctx, conversationId, modelImages, preface)
      }

      let note: string
      if (injected) {
        note = `\n\n[我已经把${sheetWord}记在眼前了；接下来可以直接引用第 k 格。]`
      } else {
        const described = await describeWithImageModel(this.deps.ctx, config, modelImages, result)
        note = described
          ? `\n\n[我现在还不能直接看图，下面是视觉帮手替我看到的]\n${described}`
          : '\n\n[我现在还不能直接看图，也没有视觉帮手；只能先依据这份文本清单回答，别假装看过画面。]'
      }
      if (omittedImages > 0) {
        note += `\n\n[还有 ${omittedImages} 张分镜图没有注入当前上下文；文本清单里仍有这些格子的时间码，` +
          '必要时用 video_zoom 或缩小窗口重看。]'
      }

      try {
        this.deps.ctx.logger.info(
          `[chatluna-video] storyboard ok input=${value.slice(0, 100)} cells=${allCells.length} ` +
          `duration=${duration.toFixed(1)}s images=${pngs.length}`,
        )
      } catch {
        /* ignore */
      }

      return text + note
    } catch (error) {
      return toolFailure(this.deps, error)
    } finally {
      release()
    }
  }
}