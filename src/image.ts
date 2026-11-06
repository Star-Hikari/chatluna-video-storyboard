import { spawn } from 'node:child_process'
import type { Config } from './config'

export interface ModelImage {
  data: Buffer
  mime: 'image/jpeg' | 'image/png'
}

const base64Size = (data: Buffer) => Math.ceil(data.length / 3) * 4

/**
 * ChatLuna/DeepSeek 的 413 来自请求体字节数，不是 token 数。
 * 上游 PNG 一张 1130×1014 约 2.1–2.3MB，base64 后约 2.7–2.9MB；
 * 两张 zoom 一起注入就会超过网关的 body limit。
 *
 * 这里统一转成 JPEG（最长边 1280、q=3），两张约 0.6MB；
 * 仍超上限时降质/缩图，最后只保留第一张，避免整轮对话失败。
 */
export async function prepareModelImages(
  pngs: Buffer[],
  config: Config,
  logger?: { warn: (message: string) => void },
): Promise<ModelImage[]> {
  const selected = pngs.slice(0, Math.max(1, config.maxImagesPerRequest || 2))
  if (selected.length === 0) return []

  let images = await Promise.all(
    selected.map((png) => encodeOne(png, config.imageMaxEdge || 1280, config.imageQuality || 3, config)),
  )

  const limit = Math.max(0.5, config.maxRequestImageMB || 2.5) * 1024 * 1024
  if (totalBase64(images) <= limit) return images

  // 第一轮压缩仍超限：再缩到 1024、质量降到 7 左右。
  images = await Promise.all(
    selected.map((png) =>
      encodeOne(png, Math.min(config.imageMaxEdge || 1280, 1024), Math.max(7, (config.imageQuality || 3) + 3), config),
    ),
  )
  if (totalBase64(images) <= limit) {
    logger?.warn('[chatluna-video] 图片请求体偏大，已降质/缩图后注入')
    return images
  }

  logger?.warn(
    `[chatluna-video] 图片请求体仍超过 ${(limit / 1048576).toFixed(1)}MB，` +
    '本轮只注入第一张；其余请用 video_zoom 单独重看。',
  )
  return images.slice(0, 1)
}

async function encodeOne(
  source: Buffer,
  maxEdge: number,
  quality: number,
  config: Config,
): Promise<ModelImage> {
  try {
    const jpeg = await ffmpegJpeg(source, maxEdge, quality, config.ffmpegPath)
    if (jpeg.length > 0 && jpeg.length < source.length) {
      return { data: jpeg, mime: 'image/jpeg' }
    }
  } catch {
    /* ffmpeg 转换失败就退回 PNG；上层还有总量保护 */
  }
  return { data: source, mime: 'image/png' }
}

function totalBase64(images: ModelImage[]): number {
  return images.reduce((total, image) => total + base64Size(image.data), 0)
}

function ffmpegJpeg(
  input: Buffer,
  maxEdge: number,
  quality: number,
  ffmpegPath: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-i', 'pipe:0',
        '-frames:v', '1',
        '-vf', `scale='min(${maxEdge},iw)':-2`,
        '-q:v', String(quality),
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )

    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false

    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => {
      if (err.reduce((n, b) => n + b.length, 0) < 8192) err.push(Buffer.from(chunk))
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out))
      } else {
        const detail = Buffer.concat(err).toString('utf8').trim().slice(0, 300)
        reject(new Error(`ffmpeg image convert failed${detail ? `: ${detail}` : ''}`))
      }
    })

    child.stdin.end(input)
  })
}