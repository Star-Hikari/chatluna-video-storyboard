import { StructuredTool } from '@langchain/core/tools'
import { h } from 'koishi'
import { z } from 'zod'
import { prepareModelImages } from '../image'
import { buildPreface, describeWithImageModel, injectSheets, modelSupportsImage, transcriptNotice } from '../inject'
import { loadUpstream, resolveDirectVideoUrl, runStoryboardWithConfig } from '../upstream'
import { assertSafeInput, isHttpUrl, sanitizeManifest } from '../utils'
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
  input: z.string().describe('与 video_storyboard 相同的视频链接或绝对路径'),
  cellId: z.number().int().min(1).optional()
    .describe('上一次 storyboard 里的格子编号；给这个就不需要 from/to'),
  from: z.number().min(0).optional().describe('窗口起点（秒），cellId 未给时必填'),
  to: z.number().min(0).optional().describe('窗口终点（秒），cellId 未给时必填'),
  cells: z.number().int().min(1).max(9).optional().describe('这张图几格；越少每格越大'),
})

type Input = z.infer<typeof schema>

export class VideoZoomTool extends StructuredTool {
  name = 'video_zoom'
  description = [
    '我可以把视频里某一小段重新放大看，只保留几格，每格更大。',
    '当分镜图里某一格看不清、需要读字幕/认人/看细节时，用 cellId 或 from/to 让我再看一眼。',
    '窗口要短（几秒到一分钟）；想看整段结构，还是用 video_storyboard。',
    '放大后的图会出现在我眼前，我可以直接说画面细节。',
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

      let from: number | undefined
      let to: number | undefined

      if (input.cellId !== undefined) {
        const hit = await this.deps.cellStore.lookup(value, input.cellId)
        if (!hit) {
          return `找不到第 ${input.cellId} 格的记录。请先对这个视频调用 video_storyboard，` +
            '或直接给 video_zoom 传 from/to 秒数。'
        }
        from = hit.from
        to = hit.to
      } else {
        from = input.from != null && Number.isFinite(Number(input.from)) ? Number(input.from) : undefined
        to = input.to != null && Number.isFinite(Number(input.to)) ? Number(input.to) : undefined
      }

      if (from === undefined || to === undefined) {
        return 'video_zoom 需要 cellId，或同时给 from 和 to（秒）。'
      }
      if (to <= from) {
        return `时间窗口无效：to（${to}s）必须大于 from（${from}s）。`
      }
      if (to - from > config.maxDurationSec) {
        return `放大窗口 ${(to - from).toFixed(0)}s 超过上限 ${config.maxDurationSec}s；请缩短窗口。`
      }

      const cells = clamp(input.cells ?? config.maxZoomCells, 1, config.maxZoomCells)
      progress.start('正在放大重看这一段…')

      const frameSource = await resolveDirectVideoUrl(config, value, 1080)
      const { format } = await loadUpstream()
      const result = await runStoryboardWithConfig(config, {
        input: value,
        from,
        to,
        cells,
        sheets: 1,
        budget: 1_200_000,
        maxPerSheet: cells,
        need: 'text',
        detail: 'high',
        pick: 'sharp',
        burn: 'index',
        minGap: 0.8,
        adaptive: false,
        audioStrip: true,
        frameSource,
        onProgress: progress.onProgress,
      })

      const sheets = Array.isArray(result.sheets) ? result.sheets : []
      const pngs = sheets.map((sheet) => sheet.png).filter((png): png is Buffer => Buffer.isBuffer(png))
      if (pngs.length === 0) throw new Error('zoom produced no image')
      const modelImages = await prepareModelImages(pngs, config, this.deps.ctx.logger)

      const text = '我把这一小段重新放大看了一遍，下面是我自己记下的细节：\n\n' +
        sanitizeManifest(format.formatForDetail(result, { detail: 'high' })) + transcriptNotice(result)

      const session = sessionOf(runConfig)
      if (config.sendSheetToChat && session) {
        for (const png of pngs.slice(0, 2)) {
          await session.send(h.image(png, 'image/png')).catch(() => {})
        }
      }

      const model = modelOf(runConfig)
      const conversationId = conversationIdOf(runConfig)
      let injected = false
      if (modelSupportsImage(model)) {
        injected = await injectSheets(this.deps.ctx, conversationId, modelImages, buildPreface(result))
      }

      let note: string
      if (injected) {
        note = '\n\n[我已经把这一小段放大看清了；可以直接说画面细节。]'
      } else {
        const described = await describeWithImageModel(this.deps.ctx, config, modelImages, result)
        note = described
          ? `\n\n[我现在还不能直接看图，下面是视觉帮手替我看到的]\n${described}`
          : '\n\n[我现在还不能直接看图，也没有视觉帮手；只能先依据这份文本清单回答，别假装看过画面。]'
      }

      try {
        this.deps.ctx.logger.info(
          `[chatluna-video] zoom ok input=${value.slice(0, 100)} ${from}-${to}s cells=${cells} ` +
          `direct=${frameSource ? 'yes' : 'no'}`,
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