import { webcrypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from 'koishi'
import qrcodeTerminal from 'qrcode-terminal'
import type { Config } from './config'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const COOKIE_INFO = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
const COOKIE_REFRESH = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'
const COOKIE_CONFIRM = 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh'
const CORRESPOND = 'https://www.bilibili.com/correspond/1/'

const COOKIE_KEYS = [
  'SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid',
  'buvid3', 'buvid4', 'buvid_fp', 'b_nut', '_uuid', 'b_lsid', 'buvid_fp',
]

const PUBLIC_KEY = {
  kty: 'RSA',
  n: 'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE',
  e: 'AQAB',
}

type CookieMap = Record<string, string>

interface SessionFile {
  refresh_token?: string
  updatedAt?: number
  uname?: string
  mid?: string
}

interface ValidateResult {
  ok: boolean
  reason: 'ok' | 'no-cookie' | 'expired' | 'network' | 'disabled'
  cookies?: CookieMap
  uname?: string
  mid?: string
  error?: unknown
}

interface QrCode {
  url: string
  key: string
}

interface PollResult {
  code?: number
  data: any
  setCookies: string[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * B 站 cookies 生命周期管理：
 *  - 启动/定时检查 nav；
 *  - 缺失或失效时在控制台渲染二维码，轮询扫码结果；
 *  - 成功后写 Netscape cookies.txt，供 yt-dlp 使用；
 *  - 检测到 cookie 需要刷新时，用 refresh_token 走官方刷新流程；
 *  - 刷新失败/过期则回退到二维码登录。
 *
 * 不依赖数据库，也不依赖旧的 bilibili-login 插件。
 */
export class BiliCookieManager {
  readonly cookieFile: string
  readonly enabled: boolean
  private readonly sessionFile: string
  private timer: any = null
  private loginPromise: Promise<boolean> | null = null
  private disposed = false
  private lastKick = 0
  private lastValid = 0
  private loggedWait = false
  private loggedScan = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    dataDir: string,
  ) {
    this.enabled = Boolean(config.biliLoginEnabled)
    const configured = String(config.cookiesFile ?? '').trim()
    this.cookieFile = configured || (this.enabled ? join(dataDir, 'cookies.txt') : '')
    this.sessionFile = join(dataDir, 'bili-session.json')
  }

  start() {
    if (!this.enabled || this.disposed) return
    this.ctx.on('dispose', () => this.stop())

    const minutes = Math.max(15, Number(this.config.biliCookieCheckMinutes) || 360)
    this.timer = setInterval(() => {
      void this.ensure('periodic').catch((error) => {
        this.warn(`定时检查 B 站 cookies 失败：${this.message(error)}`)
      })
    }, minutes * 60_000)
    if (typeof this.timer?.unref === 'function') this.timer.unref()

    this.ctx.logger.info(
      `[chatluna-video] B站登录：启动检查 cookies（每 ${minutes} 分钟复查）` +
      (this.cookieFile ? `；文件 ${this.cookieFile}` : '；未启用自动登录'),
    )
    void this.ensure('startup').catch((error) => {
      this.warn(`启动检查 B 站 cookies 失败：${this.message(error)}`)
    })
  }

  stop() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 工具调用前轻量触发一次检查；不阻塞工具本身。 */
  kick() {
    if (!this.enabled || this.disposed || this.loginPromise) return
    const now = Date.now()
    if (now - this.lastKick < 5 * 60_000) return
    this.lastKick = now
    void this.ensure('tool').catch((error) => {
      this.warn(`检查 B 站 cookies 失败：${this.message(error)}`)
    })
  }

  async ensure(reason: 'startup' | 'periodic' | 'tool'): Promise<boolean> {
    if (!this.enabled || this.disposed) return false
    if (this.loginPromise) return this.loginPromise

    const status = await this.validate()
    if (status.ok) {
      this.lastValid = Date.now()
      if (reason !== 'tool') {
        this.ctx.logger.info(
          `[chatluna-video] B站 cookies 有效${status.uname ? `：${status.uname}` : ''}` +
          (status.mid ? `（UID ${status.mid}）` : ''),
        )
        if (this.config.biliRefreshToken) {
          try {
            await this.refreshIfNeeded(status)
          } catch (error) {
            this.warn(`B站 cookie 自动刷新失败：${this.message(error)}`)
          }
        }
      }
      return true
    }

    if (status.reason === 'network') {
      this.warn(`B站 cookies 检查请求失败（网络/风控），稍后再试：${this.message(status.error)}`)
      return false
    }
    if (status.reason === 'disabled') return false

    const why = status.reason === 'no-cookie' ? '未找到可用 cookies' : 'cookies 已失效'
    this.warn(`${why}，开始扫码登录（控制台会输出二维码）`)

    this.loginPromise = this.loginFlow()
      .then(() => true)
      .catch((error) => {
        this.warn(`B站扫码登录失败/超时：${this.message(error)}`)
        return false
      })
      .finally(() => {
        this.loginPromise = null
      })

    return this.loginPromise
  }

  private async validate(): Promise<ValidateResult> {
    const cookies = await this.readCookies()
    if (!cookies.SESSDATA) return { ok: false, reason: 'no-cookie', cookies }

    try {
      const data = await this.nav(cookies)
      if (data?.isLogin) {
        return {
          ok: true,
          reason: 'ok',
          cookies,
          uname: data.uname,
          mid: data.mid != null ? String(data.mid) : undefined,
        }
      }
      return { ok: false, reason: 'expired', cookies }
    } catch (error) {
      return { ok: false, reason: 'network', cookies, error }
    }
  }

  private async nav(cookies: CookieMap): Promise<any | null> {
    const res = await this.request(NAV, { method: 'GET' }, cookies)
    const json: any = await res.json()
    return json?.code === 0 ? json.data : null
  }

  private async loginFlow(): Promise<void> {
    const deadline = Date.now() + Math.max(60, this.config.biliQrTimeoutSec || 180) * 1000
    const maxRefresh = Math.max(1, this.config.biliQrMaxRefresh || 3)
    let refreshes = 0
    let qr = await this.generateQr()
    this.loggedWait = false
    this.loggedScan = false
    this.renderQr(qr.url)

    while (true) {
      if (this.disposed) throw new Error('插件已卸载')
      if (Date.now() > deadline) throw new Error('二维码登录超时')
      await sleep(2000)
      if (this.disposed) throw new Error('插件已卸载')

      let poll: PollResult
      try {
        poll = await this.pollQr(qr.key)
      } catch (error) {
        this.warn(`二维码轮询失败，继续等待：${this.message(error)}`)
        await sleep(2000)
        continue
      }
      const code = Number(poll.data?.code)
      if (code === 0) {
        await this.finishLogin(poll)
        return
      }

      if (code === 86101) {
        if (!this.loggedWait) {
          this.loggedWait = true
          this.ctx.logger.info('[chatluna-video] 等待扫码…')
        }
        continue
      }
      if (code === 86090) {
        if (!this.loggedScan) {
          this.loggedScan = true
          this.ctx.logger.info('[chatluna-video] 已扫码，请在手机客户端确认登录…')
        }
        continue
      }
      if (code === 86038) {
        refreshes++
        if (refreshes > maxRefresh) throw new Error('二维码多次过期')
        this.ctx.logger.info('[chatluna-video] 二维码已过期，重新生成…')
        qr = await this.generateQr()
        this.loggedWait = false
        this.loggedScan = false
        this.renderQr(qr.url)
        continue
      }

      this.warn(`二维码轮询返回未知状态 code=${code ?? poll.code ?? '?'}`)
    }
  }

  private async generateQr(): Promise<QrCode> {
    const res = await this.request(QR_GENERATE, { method: 'GET' })
    const json: any = await res.json()
    if (json?.code !== 0 || !json?.data?.url || !json?.data?.qrcode_key) {
      throw new Error(`获取二维码失败：${json?.message ?? 'unknown'}`)
    }
    return { url: json.data.url, key: json.data.qrcode_key }
  }

  private renderQr(url: string) {
    const minutes = Math.max(1, Math.round((this.config.biliQrTimeoutSec || 180) / 60))
    this.ctx.logger.info(`[chatluna-video] 请使用 B 站手机客户端扫描二维码登录（约 ${minutes} 分钟内有效）：`)
    qrcodeTerminal.generate(url, { small: true }, (qr) => {
      this.ctx.logger.info(`\n${qr}`)
    })
  }

  private async pollQr(key: string): Promise<PollResult> {
    const res = await this.request(
      `${QR_POLL}?qrcode_key=${encodeURIComponent(key)}`,
      { method: 'GET' },
    )
    const json: any = await res.json()
    return {
      code: json?.code,
      data: json?.data ?? {},
      setCookies: setCookiesOf(res),
    }
  }

  private async finishLogin(poll: PollResult): Promise<void> {
    const data = poll.data ?? {}
    const url = String(data.url ?? '')
    if (!url) throw new Error('扫码成功但未返回 cookie URL')

    const params = new URL(url).searchParams
    const cookies: CookieMap = { ...parseSetCookieList(poll.setCookies) }
    for (const key of COOKIE_KEYS) {
      const value = params.get(key)
      if (value) cookies[key] = value
    }

    for (const required of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']) {
      if (!cookies[required]) throw new Error(`登录返回缺少 ${required}`)
    }

    const nav = await this.nav(cookies)
    if (!nav?.isLogin) throw new Error('登录后 nav 仍未登录')

    await this.saveCookies(cookies, params.get('Expires'))
    await this.saveSession({
      refresh_token: data.refresh_token || '',
      updatedAt: Date.now(),
      uname: nav.uname,
      mid: nav.mid != null ? String(nav.mid) : undefined,
    })

    this.lastValid = Date.now()
    this.ctx.logger.info(
      `[chatluna-video] B站登录成功：${nav.uname ?? 'unknown'}` +
      `${nav.mid ? `（UID ${nav.mid}）` : ''}；cookies 已写入 ${this.cookieFile}`,
    )
  }

  private async refreshIfNeeded(status: ValidateResult): Promise<boolean> {
    if (!this.config.biliRefreshToken) return false
    const cookies = status.cookies ?? await this.readCookies()
    if (!cookies.SESSDATA || !cookies.bili_jct) return false

    const session = await this.loadSession()
    if (!session.refresh_token) return false

    const info = await this.cookieInfo(cookies)
    if (info?.code !== 0) return false
    if (!info?.data?.refresh) return false

    this.ctx.logger.info('[chatluna-video] 检测到 B 站 cookie 需要刷新，正在自动刷新…')
    const timestamp = Number(info.data.timestamp) || Date.now()
    const correspondPath = await this.correspondPath(timestamp)
    const refreshCsrf = await this.getRefreshCsrf(correspondPath, cookies)
    const refreshed = await this.refreshCookies(cookies, refreshCsrf, session.refresh_token)
    const nav = await this.nav(refreshed.cookies)
    if (!nav?.isLogin) throw new Error('刷新后 nav 仍未登录')

    // 官方要求：用新的 bili_jct + 旧的 refresh_token 确认，使旧 token 失效。
    try {
      await this.confirmRefresh(refreshed.cookies.bili_jct, session.refresh_token, refreshed.cookies)
    } catch (error) {
      this.warn(`B站 confirm/refresh 失败（新 cookies 仍可用）：${this.message(error)}`)
    }

    await this.saveCookies(refreshed.cookies, null)
    await this.saveSession({
      ...session,
      refresh_token: refreshed.refreshToken || session.refresh_token,
      updatedAt: Date.now(),
      uname: nav.uname,
      mid: nav.mid != null ? String(nav.mid) : session.mid,
    })
    this.lastValid = Date.now()
    this.ctx.logger.info(`[chatluna-video] B站 cookies 已自动刷新：${nav.uname ?? 'unknown'}`)
    return true
  }

  private async cookieInfo(cookies: CookieMap): Promise<any> {
    const url = `${COOKIE_INFO}?csrf=${encodeURIComponent(cookies.bili_jct)}`
    const res = await this.request(url, { method: 'GET' }, cookies)
    return res.json()
  }

  private async correspondPath(timestamp: number): Promise<string> {
    const key = await webcrypto.subtle.importKey(
      'jwk',
      PUBLIC_KEY as JsonWebKey,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    )
    const data = new TextEncoder().encode(`refresh_${timestamp}`)
    const encrypted = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      key,
      data,
    ))
    return Buffer.from(encrypted).toString('hex')
  }

  private async getRefreshCsrf(path: string, cookies: CookieMap): Promise<string> {
    const res = await this.request(`${CORRESPOND}${path}`, { method: 'GET' }, cookies)
    const html = await res.text()
    const match = html.match(/id=["']1-name["'][^>]*>([^<]+)</i)
    const token = match?.[1]?.trim()
    if (!token) throw new Error('无法从 correspond 页面解析 refresh_csrf')
    return token
  }

  private async refreshCookies(
    cookies: CookieMap,
    refreshCsrf: string,
    refreshToken: string,
  ): Promise<{ cookies: CookieMap; refreshToken: string }> {
    const body = new URLSearchParams({
      csrf: cookies.bili_jct,
      refresh_csrf: refreshCsrf,
      source: 'main_web',
      refresh_token: refreshToken,
    })
    const res = await this.request(COOKIE_REFRESH, { method: 'POST', body }, cookies)
    const json: any = await res.json()
    if (json?.code !== 0) {
      throw new Error(`refresh cookie 失败：${json?.message ?? 'unknown'} (code ${json?.code})`)
    }
    const merged = { ...cookies, ...parseSetCookieList(setCookiesOf(res)) }
    return {
      cookies: merged,
      refreshToken: json?.data?.refresh_token || refreshToken,
    }
  }

  private async confirmRefresh(
    csrf: string,
    oldRefreshToken: string,
    cookies: CookieMap,
  ): Promise<void> {
    const body = new URLSearchParams({
      csrf,
      refresh_token: oldRefreshToken,
    })
    const res = await this.request(COOKIE_CONFIRM, { method: 'POST', body }, cookies)
    const json: any = await res.json()
    if (json?.code !== 0) {
      throw new Error(`confirm refresh 失败：${json?.message ?? 'unknown'} (code ${json?.code})`)
    }
  }

  private async readCookies(): Promise<CookieMap> {
    if (!this.cookieFile || !existsSync(this.cookieFile)) return {}
    try {
      const raw = await readFile(this.cookieFile, 'utf8')
      const cookies: CookieMap = {}
      for (const original of raw.split(/\r?\n/)) {
        let line = original.trim()
        if (!line) continue
        if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length)
        if (!line || line.startsWith('#')) continue
        const fields = line.split('\t')
        if (fields.length >= 7) {
          const name = fields[5]?.trim()
          const value = fields[6]?.trim()
          if (name && value) cookies[name] = value
          continue
        }
        // 兼容极简的 name=value 文件
        const eq = line.indexOf('=')
        if (eq > 0) cookies[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
      return cookies
    } catch {
      return {}
    }
  }

  private async saveCookies(cookies: CookieMap, expiresRaw: string | null): Promise<void> {
    if (!this.cookieFile) return
    const expires = normalizeExpires(expiresRaw)
    const lines = ['# Netscape HTTP Cookie File', '# Generated by chatluna-video-storyboard']
    for (const [name, value] of Object.entries(cookies)) {
      if (!value || /[\t\r\n]/.test(value)) continue
      lines.push(`.bilibili.com\tTRUE\t/\tFALSE\t${expires}\t${name}\t${value}`)
    }
    await mkdir(dirname(this.cookieFile), { recursive: true })
    await writeFile(this.cookieFile, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.cookieFile, 0o600).catch(() => {})
    process.env.DSH_VIDEO_COOKIES = this.cookieFile
  }

  private async loadSession(): Promise<SessionFile> {
    try {
      const raw = JSON.parse(await readFile(this.sessionFile, 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private async saveSession(session: SessionFile): Promise<void> {
    try {
      await mkdir(dirname(this.sessionFile), { recursive: true })
      await writeFile(this.sessionFile, JSON.stringify(session), {
        encoding: 'utf8',
        mode: 0o600,
      })
      await chmod(this.sessionFile, 0o600).catch(() => {})
    } catch {
      /* 会话文件写失败不影响 cookies 使用；下次刷新会回退二维码 */
    }
  }

  private async request(url: string, init: RequestInit = {}, cookies?: CookieMap): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('User-Agent', UA)
    headers.set('Referer', REFERER)
    headers.set('Accept', 'application/json, text/plain, */*')
    if (init.method === 'POST') headers.set('Origin', 'https://www.bilibili.com')
    if (cookies && Object.keys(cookies).length > 0) {
      headers.set('Cookie', Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '))
    }
    const timeout = (AbortSignal as any).timeout?.(20_000)
    const res = await fetch(url, {
      ...init,
      headers,
      redirect: 'follow',
      ...(init.signal ? {} : timeout ? { signal: timeout } : {}),
    })
    if (!res.ok) throw new Error(`Bilibili HTTP ${res.status}`)
    return res
  }

  private warn(message: string) {
    try {
      this.ctx.logger.warn(`[chatluna-video] ${message}`)
    } catch {
      /* ignore */
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? 'unknown')
  }
}

function normalizeExpires(raw: string | null): number {
  if (raw) {
    const num = Number(raw)
    if (Number.isFinite(num) && num > 0) {
      return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num)
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000) + 30 * 24 * 3600
}

function setCookiesOf(res: Response): string[] {
  const headers: any = res.headers
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const raw = headers.get('set-cookie')
  if (!raw) return []
  return String(raw).split(/,(?=\s*[^;,=]+=)/)
}

function parseSetCookieList(list: string[]): CookieMap {
  const cookies: CookieMap = {}
  for (const item of list) {
    const first = String(item).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (name && value) cookies[name] = value
  }
  return cookies
}