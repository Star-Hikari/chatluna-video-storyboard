declare module 'dsh-video-storyboard-patched/pipeline' {
  export interface StoryboardOptions {
    input: string
    from?: number
    to?: number
    segment?: number
    strategy?: 'auto' | 'full' | 'standard' | 'compact' | 'native' | 'skim' | 'brief'
    maxFrames?: number
    maxSheets?: number
    minFrames?: number
    uniformTier?: 'auto' | number | null
    tierMap?: Record<string, number> | null
    tierCurve?: 'docx' | 'perceptual' | null
    budget?: number
    cutFloor?: number
    scanGap?: number
    integral?: boolean
    integralSeconds?: number
    planOnly?: boolean
    maxCanvasSide?: number
    pick?: 'sharp' | 'mid' | 'thumb'
    burn?: 'index' | 'none'
    transcript?: 'auto' | 'off'
    transcriptFile?: string
    asrKey?: string
    hotwords?: string
    ocr?: boolean
    audioStrip?: boolean
    textOnly?: boolean
    encode?: boolean
    cache?: boolean
    sourceHash?: boolean
    frameConcurrency?: number
    ffmpegPath?: string
    ffprobePath?: string
    frameSource?: {
      uri: string
      userAgent?: string
      referer?: string
      height?: number
      expiresAt?: number
    } | null
    fetchOptions?: Record<string, any> | null
    onProgress?: (p: any) => void
    [key: string]: any
  }

  export interface StoryboardCell {
    i: number
    sheet?: number
    t_start: number
    t_end: number
    t_frame?: number
    tier?: number
    cell?: { w: number; h: number }
    text?: string
    lines?: Array<{ from: number; to: number; text: string }>
  }

  export interface StoryboardSheet {
    sheet: number
    cols: number
    rows: number
    cellW: number
    cellH: number
    width: number
    height: number
    buffer: Buffer
    png?: Buffer
    cells: StoryboardCell[]
  }

  export interface StoryboardResult {
    info: { path?: string; duration: number; [key: string]: any }
    window: { from: number; to: number; duration: number }
    sheets: StoryboardSheet[]
    transcript?: {
      source: string
      chars?: number
      model?: string | null
      ai?: boolean
      aiSubtitleSkipped?: boolean
      fallback?: string
      asrError?: string
      error?: string
      [key: string]: any
    } | null
    plan?: Record<string, any>
    segment?: { sec: number; index: number; total: number; leftSec: number }
    [key: string]: any
  }

  export function runStoryboard(opts: StoryboardOptions): Promise<StoryboardResult>
  export function formatManifest(result: StoryboardResult, opts?: any): string
}

declare module 'dsh-video-storyboard-patched/format' {
  export function formatForDetail(
    result: any,
    opts?: { detail?: 'low' | 'med' | 'high'; maxChars?: number; cellRange?: number[] | null },
  ): string
  export function formatProbe(info: any): Promise<string>
  export function formatRemoteProbe(remote: any): string
}

declare module 'dsh-video-storyboard-patched/probe' {
  export function probeVideo(input: string, opts?: { ffprobePath?: string }): Promise<any>
  export const DEFAULT_FFMPEG: string
  export const DEFAULT_FFPROBE: string
}

declare module 'dsh-video-storyboard-patched/ytdlp' {
  export interface YtdlpTool {
    bin: string
    prefix: string[]
  }
  export function discoverYtdlp(opts?: { env?: NodeJS.ProcessEnv; run?: any }): Promise<YtdlpTool>
  export function runProcess(
    tool: YtdlpTool,
    args: string[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; code: number }>
  export function summariseInfo(info: any): any
  export function unwrapSingle(info: any, url: string): any
  export function explainYtdlpError(stderr: string, code?: number): string
  export const DEFAULT_UA: string
}

declare module 'dsh-video-storyboard-patched/board' {
  export function boardOptions(args: any, opts?: { kind?: 'board' | 'zoom' | 'watch'; frameSource?: any }): any
  export function boardGeometry(args: any): any
}