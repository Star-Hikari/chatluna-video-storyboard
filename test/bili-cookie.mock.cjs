const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { BiliCookieManager } = require('../lib/index.js')

const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const COOKIE_INFO = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
const COOKIE_REFRESH = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'
const COOKIE_CONFIRM = 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh'
const CORRESPOND = 'https://www.bilibili.com/correspond/1/'

function json(data, setCookies = []) {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(data), { status: 200, headers })
}

let loggedIn = false
let refreshNeeded = false
let confirmBody = ''

global.fetch = async (url, init = {}) => {
  const target = String(url)
  if (target === NAV) {
    const cookie = new Headers(init.headers).get('cookie') || ''
    return json({
      code: 0,
      data: { isLogin: loggedIn && cookie.includes('SESSDATA='), uname: 'MockUser', mid: 12345 },
    })
  }
  if (target === QR_GENERATE) {
    return json({
      code: 0,
      data: {
        url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=mock-key',
        qrcode_key: 'mock-key',
      },
    })
  }
  if (target.startsWith(QR_POLL)) {
    loggedIn = true
    return json({
      code: 0,
      data: {
        code: 0,
        url: 'https://passport.bilibili.com/login?SESSDATA=sess&DedeUserID=12345' +
          '&DedeUserID__ckMd5=md5&bili_jct=csrf&Expires=1893456000&gourl=https%3A%2F%2Fwww.bilibili.com',
        refresh_token: 'refresh-1',
      },
    }, [
      'SESSDATA=sess; Path=/; Domain=.bilibili.com; HttpOnly',
      'bili_jct=csrf; Path=/; Domain=.bilibili.com',
    ])
  }
  if (target.startsWith(COOKIE_INFO)) {
    return json({ code: 0, data: { refresh: refreshNeeded, timestamp: Date.now() } })
  }
  if (target.startsWith(CORRESPOND)) {
    return new Response('<html><div id="1-name">refresh-csrf</div></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }
  if (target === COOKIE_REFRESH) {
    return json({ code: 0, data: { status: 0, refresh_token: 'refresh-2' } }, [
      'SESSDATA=sess2; Path=/; Domain=.bilibili.com',
      'bili_jct=csrf2; Path=/; Domain=.bilibili.com',
    ])
  }
  if (target === COOKIE_CONFIRM) {
    confirmBody = new URLSearchParams(init.body).toString()
    return json({ code: 0 })
  }
  throw new Error(`unexpected fetch: ${target}`)
}

;(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-cookie-test-'))
  const cookieFile = path.join(dir, 'cookies.txt')
  const logs = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(args.map(String).join(' ')),
      warn: (...args) => logs.push('WARN ' + args.map(String).join(' ')),
    },
    on() {},
  }
  const manager = new BiliCookieManager(ctx, {
    biliLoginEnabled: true,
    cookiesFile: cookieFile,
    biliQrTimeoutSec: 30,
    biliQrMaxRefresh: 2,
    biliRefreshToken: true,
  }, dir)

  try {
    // 1) 无 cookie -> 生成二维码 -> 轮询成功 -> 写 Netscape cookies + session
    const ok = await manager.ensure('startup')
    assert.equal(ok, true)
    const cookieText = fs.readFileSync(cookieFile, 'utf8')
    assert.match(cookieText, /SESSDATA\tsess/)
    assert.match(cookieText, /bili_jct\tcsrf/)
    const session1 = JSON.parse(fs.readFileSync(path.join(dir, 'bili-session.json'), 'utf8'))
    assert.equal(session1.refresh_token, 'refresh-1')
    assert.match(logs.join('\n'), /登录成功/)

    // 2) cookie/info 要求刷新 -> RSA correspond -> refresh -> confirm 用旧 token
    refreshNeeded = true
    const refreshed = await manager.ensure('periodic')
    assert.equal(refreshed, true)
    const cookieText2 = fs.readFileSync(cookieFile, 'utf8')
    assert.match(cookieText2, /SESSDATA\tsess2/)
    assert.match(cookieText2, /bili_jct\tcsrf2/)
    const session2 = JSON.parse(fs.readFileSync(path.join(dir, 'bili-session.json'), 'utf8'))
    assert.equal(session2.refresh_token, 'refresh-2')
    assert.match(confirmBody, /refresh_token=refresh-1/)
    assert.match(confirmBody, /csrf=csrf2/)
    assert.match(logs.join('\n'), /已自动刷新/)

    console.log('BILI COOKIE MOCK OK')
    console.log(logs.join('\n'))
  } finally {
    manager.stop()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})