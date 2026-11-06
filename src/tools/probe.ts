import { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { probeInput } from '../upstream'
import { assertSafeInput, isHttpUrl } from '../utils'
import { toolFailure, type ToolDeps } from './shared'

const schema = z.object({
  input: z.string().describe('视频链接（http/https）或服务器上的绝对路径'),
})

export class VideoProbeTool extends StructuredTool {
  name = 'video_probe'
  description = [
    '我可以先看一眼视频的基本信息：时长、分辨率、帧率、有没有音轨/字幕轨、能拿到哪些清晰度。',
    '当我还不知道视频多长、该整片看还是分段看时，先让我用 video_probe 看一眼。',
    '这一步不花图片 token，也不会下载视频，只是让我心里有数。',
  ].join('\n')

  schema = schema

  constructor(private readonly deps: ToolDeps) {
    super({})
  }

  async _call(input: z.infer<typeof schema>): Promise<string> {
    try {
      const value = assertSafeInput(input.input)
      if (isHttpUrl(value)) this.deps.cookieManager.kick()
      const result = await probeInput(this.deps.config, value)
      return `我先看了一眼这个视频的基本信息：\n${result.text}\n\n` +
        '接下来我可以根据这些信息决定是整片看，还是用 from/segment 分段看。'
    } catch (error) {
      return toolFailure(this.deps, error)
    }
  }
}