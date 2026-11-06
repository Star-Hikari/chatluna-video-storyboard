import type { Context, Session } from 'koishi'
import type { BiliCookieManager } from '../bili-cookie'
import type { Config } from '../config'
import type { CellStore } from '../cell-store'
import type { Semaphore } from '../utils'
import { humanizeError } from '../utils'

export interface ToolDeps {
  ctx: Context
  config: Config
  cellStore: CellStore
  semaphore: Semaphore
  cookieManager: BiliCookieManager
}

export function sessionOf(runConfig: any): Session | undefined {
  return runConfig?.configurable?.session
}

export function conversationIdOf(runConfig: any): string | undefined {
  return runConfig?.configurable?.agentContext?.conversationId
}

export function modelOf(runConfig: any): any {
  return runConfig?.configurable?.model
}

export function toolFailure(deps: ToolDeps, error: unknown): string {
  const detail = humanizeError(error)
  try {
    deps.ctx.logger.warn(`[chatluna-video] ${error instanceof Error ? error.stack ?? error.message : error}`)
  } catch {
    /* 日志不可用也不影响返回 */
  }
  return `我这次没能看清这个视频：${detail}\n` +
    '我不会假装看过。先按上面的提示检查一下，或者换一个更短的视频/把链接再发我一次；' +
    '不要用完全相同的参数立刻重试。'
}

function say(session: Session | undefined, text: string) {
  if (!session) return
  void Promise.resolve(session.send(text)).catch(() => {})
}

/** 每个阶段只提示一次，避免 onProgress 每帧刷屏。 */
export function createProgress(deps: ToolDeps, session: Session | undefined) {
  const seen = new Set<string>()
  const enabled = deps.config.progress

  return {
    start(text = '正在看视频，预计需要几十秒…') {
      if (enabled) say(session, text)
    },
    onProgress(p: any) {
      if (!enabled || !p) return
      const phase = p.phase
      if (phase && !seen.has(phase)) {
        seen.add(phase)
        if (phase === 'resolve') say(session, '正在解析视频链接…')
        else if (phase === 'download') say(session, '正在下载低清扫描副本（只需一次，之后走缓存）…')
        else if (phase === 'cache-hit') say(session, '命中视频缓存，开始扫描画面…')
        else if (phase === 'cache-invalid') say(session, '缓存不完整，正在重新下载…')
      }
    },
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}