# koishi-plugin-chatluna-video-storyboard

让 ChatLuna 模型真正“看”视频：用 ffmpeg 把视频抽帧拼成一张带编号的宫格图，再配一份 `cell k = 时间码 + 台词` 的文本清单；模型可以引用某一格，也可以继续 `video_zoom` 放大重看。

对话环境按 QQ / OneBot 设计，不需要在 B 站发评论或做任何写操作。

---

## 功能

| 工具 | 作用 | 是否出图 |
|---|---|---|
| `video_probe` | 只读元信息：时长、分辨率、音轨、字幕轨、可用清晰度、建议读法 | 否 |
| `video_storyboard` | 全片或一段的宫格图 + 文本清单 | 是 |
| `video_zoom` | 对某一格 / 某一段时间近距离重看 | 是 |

- 宫格图编号烧进像素，模型能引用“第 5 格”，而不是数格子。
- 支持 `cellId` 寻址：`video_storyboard` 后直接 `video_zoom({ cellId: 5 })`。
- 长视频用 `from` / `segment` 分段，不会一次把全片铺开。
- 图片通过 `contextManager.inject` 以 `data:image/png;base64,...` 注入，不依赖公网图片服务。
- 主模型不支持图片时，可用 `imageModel` 转述；但推荐直接用支持图像的模型。

---

## 依赖

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| ffmpeg / ffprobe | 必需 | 抽帧、拼图、音频分析；建议 7.0+ |
| yt-dlp | 链接模式必需 | 解析 B 站/网页链接、下载低清扫描副本、取 1080P 直链 |
| cookies.txt | 可选/自动 | 1080P 与站点字幕需要登录；插件可在控制台扫码自动生成，也可手动放 Netscape 文件 |
| ASR 端点 | 可选 | 站点没有 CC、又需要台词时使用；云端/本地均可 |

二维码由 `qrcode-terminal` 渲染（Apache-2.0），作为 npm 依赖自动安装，不需要额外配置。

### 安装

#### 插件市场 / npm

在 Koishi 控制台的「插件市场」搜索 `chatluna-video-storyboard` 安装，或：

```bash
npm install koishi-plugin-chatluna-video-storyboard
```

插件会自动安装 `dsh-video-storyboard-patched` 与 `qrcode-terminal`，不需要手动装上游。

#### 外部程序

Windows：

```powershell
winget install ffmpeg
winget install yt-dlp
# 或：pip install --user -U yt-dlp
```

Linux：

```bash
sudo apt install ffmpeg
pipx install yt-dlp
# 或从 yt-dlp releases 下载单文件放到 /usr/local/bin
```

验证：

```bash
ffmpeg -version
ffprobe -version
yt-dlp --version
```

---

## 开发构建与启用

> 从插件市场安装的用户可以跳过本节，直接在控制台启用插件。

本仓库的开发构建：

```bash
cd koishi-app
yarn install
yarn workspace koishi-plugin-chatluna-video-storyboard build
```

`dsh-video-storyboard-patched` 是独立的 npm 依赖，源码放在 `koishi-app/vendor/dsh-video-storyboard-patched`，不是 Koishi 插件 workspace；本地开发时用 junction 链接，正式安装时从 npm 拉取。

构建产物是 `lib/index.js`（CJS）。在 `koishi.yml` 中启用：

```yaml
plugins:
  chatluna-video-storyboard:video1:
    ffmpegPath: ffmpeg
    ffprobePath: ffprobe
    # ytdlpPath: /usr/local/bin/yt-dlp   # 留空自动发现
    # cookiesFile: /opt/koishi/data/chatluna-video/cookies.txt
    # ↑ 可留空：默认使用 dataDir/cookies.txt，由扫码登录自动维护
    dataDir: data/chatluna-video
    maxDurationSec: 600
    maxCells: 9
    maxZoomCells: 6
    maxConcurrent: 1
    frameConcurrency: 2
    progress: true
    sendSheetToChat: false
    imageModel: 无
    advancedImage: false
    imageMaxEdge: 1280
    imageQuality: 3
    maxRequestImageMB: 2.5
    maxImagesPerRequest: 2
    allowedGroups: []
    biliLoginEnabled: true
    biliCookieCheckMinutes: 360
    biliQrTimeoutSec: 180
    biliQrMaxRefresh: 3
    biliRefreshToken: true
    asrEnabled: true
    asrOnAiSubtitle: false
    asrBaseUrl: https://api.siliconflow.cn/v1
    asrApiKey: sk-xxxx
    asrModel: FunAudioLLM/SenseVoiceSmall
    asrLanguage: zh
    asrHotwords: ''
```

配置页按功能分成 6 组：

| 分组 | 内容 |
|---|---|
| 运行依赖 | ffmpeg / ffprobe / yt-dlp |
| 存储与限制 | 缓存目录、缓存上限、时长/格数/并发 |
| B 站登录 | 自动登录开关、cookies 路径、检查/二维码参数 |
| 台词 / ASR | 台词开关、AI 字幕重跑、ASR 连接 |
| 交互与图片 | 进度提示、是否发图、图片模型、高级图片参数 |
| 权限与调试 | 群白名单、调试日志 |

条件隐藏：

- 关闭 **B 站自动登录**：检查间隔、二维码超时、刷新次数、refresh_token 整组隐藏；`cookiesFile` 仍保留，方便手动提供。
- 关闭 **台词层**：AI 字幕重跑和 ASR 连接整组隐藏。
- 关闭 **高级图片参数**：最长边、JPEG 质量、请求体上限、单轮图片数隐藏；运行时按默认值 1280 / 3 / 2.5MB / 2 张处理。

插件只注册工具，不添加命令；需要 ChatLuna 处于 Agent / plugin 模式（`chatluna-agent` 已安装时按默认权限启用）。

### 发布到 npm 时

插件依赖两个普通 npm 包，不能使用 `workspace:*`：

```json
"dsh-video-storyboard-patched": "^0.5.5",
"qrcode-terminal": "^0.12.0"
```

AI 字幕识别和 MiMo ASR 是对上游 0.5.4 的本地补丁，已做成独立 fork：

- 源码：`koishi-app/vendor/dsh-video-storyboard-patched`
- 包名：`dsh-video-storyboard-patched`
- 版本：`0.5.5`
- 许可证：Apache-2.0（LICENSE / NOTICE 随 fork 发布）

发布顺序：

```bash
# 1. 先发 patched fork
cd koishi-app/vendor/dsh-video-storyboard-patched
npm publish

# 2. 再发插件
cd ../../external/chatluna-video-storyboard
npm publish
```

> fork 是库，不是 Koishi 插件，不要用 `yarn setup` 在 `external/` 下创建它；否则 `yarn install` 可能按插件 workspace 规则清理目录。

---

## 怎么用

在 QQ 里直接发链接并提问：

```text
看看这个视频讲了什么 https://www.bilibili.com/video/BV...
```

模型通常会：

1. `video_probe` 看时长/有没有台词；
2. `video_storyboard` 出第一张宫格；
3. 下一轮看到注入的宫格图，用中文回答，并引用 `第 k 格（时间码）`。

追问：

```text
第 3 格那个镜头是什么？
视频第 2 分钟说了什么？
再放大看看 1:12 附近
```

会走 `video_zoom({ cellId: 3 })` 或 `video_zoom({ from: 72, to: 80 })`。

长视频：

```text
先看前 5 分钟
```

模型应调用：

```js
video_storyboard({ input, from: 0, segment: 300 })
```

结果末尾会带 `next: from=...`；继续看下一段时传同一个 `segment`。

---

## ASR：服务器性能怎么选

### 方案 A：云端 OpenAI 兼容 ASR（推荐给小服务器）

例如 SiliconFlow：

```yaml
asrEnabled: true
asrBaseUrl: https://api.siliconflow.cn/v1
asrApiKey: sk-xxxx
asrModel: FunAudioLLM/SenseVoiceSmall
asrLanguage: zh
```

- 本地几乎不占 CPU/内存，只占网络带宽。
- 45 秒音频一个请求；插件会按 ≤45 秒切片，避免长请求时间码漂移。
- 适合 2C4G 的小 VPS；按量计费，成本通常远低于让本地 CPU 长时间转写。
- 缺点：视频音频要上传到云端；隐私/合规需自行确认。

### 方案 A2：小米 MiMo ASR（OpenAI Chat Completions 风格）

MiMo 的 ASR 不是 `/audio/transcriptions`，而是 `/chat/completions` + `input_audio`。插件会自动识别 `api.xiaomimimo.com` 或 `mimo-*-asr` 并切换协议，不需要额外配置：

```yaml
asrEnabled: true
asrBaseUrl: https://api.xiaomimimo.com/v1
asrApiKey: <MiMo API Key>
asrModel: mimo-v2.5-asr
asrLanguage: ''   # 留空=auto；也可 zh / en
```

- 官方接口不返回逐句时间码；插件会把返回文本按标点拆句，再按字符数均摊到当前音频窗口，时间码是近似的。
- MiMo 对**口播**效果很好；对**纯音乐/歌词**可能只返回“啦啦啦”之类的稀疏文本，上游会按“音乐段幻觉”过滤掉。
- 如果原视频有 AI 字幕，空结果会自动回退 AI 字幕（`fallback: "asr-empty"`），不会丢台词；所以 `asrOnAiSubtitle: true` 对音乐视频也安全。若希望音乐视频完全不请求 ASR，可以设为 `false`。

### 方案 B：本地 sherpa-onnx / SenseVoice（无 GPU 也能跑）

- 模型约 **500MB**（含标点），常驻内存约 **1–2GB**。
- 不需要 GPU；CPU 即可，45 秒音频在 16 核上约 **2.1 秒**，2–4 核大约 **5–10 秒**（仍快于实时）。
- 冷启动约 **2 秒**（sherpa）；FunASR 冷启动约 30 秒、模型约 2.1GB，小服务器不推荐。
- 需要 Python/ONNX Runtime 或一个 OpenAI 兼容的本地服务；把 `asrBaseUrl` 指向 `http://127.0.0.1:8000/v1`，`asrApiKey` 留空即可。
- 本地 ASR 会和 ffmpeg 抢 CPU；建议 `maxConcurrent: 1`、`frameConcurrency: 2`。

### B 站 AI 字幕怎么区分

B 站字幕轨的语言 id 可以区分：

- `zh-Hans` / `zh-CN` / `en-US`：UP 主上传/人工字幕；
- `ai-zh` / `ai-en`：B 站 AI 生成字幕。

插件会：

- 把 AI 字幕标成 `transcript="subtitle-ai"`，并在工具结果和注入前言里提醒“可能有错字/漏句”；
- `asrOnAiSubtitle: true` 时，检测到 AI 字幕会优先用 ASR 重跑；
- ASR 不可用或失败时，自动回退到 AI 字幕，不会让整段台词消失；
- `asrOnAiSubtitle: false` 时直接用 AI 字幕，只做准确性提醒。

> 当前这台机器已适配小米 MiMo，`koishi.yml` 里设成了 `true`。如果 ASR 对纯音乐返回空结果，会自动回退 AI 字幕，不会丢台词。

### 方案 C：不配 ASR

```yaml
asrEnabled: false
```

只出画面。B 站有 CC 字幕时仍可能拿到字幕（需要 cookies）；没有 CC 就没有台词。

### 服务器建议

| 场景 | 建议 |
|---|---|
| 只跑云端 ASR + 短视频 | 2C4G，10GB 磁盘 |
| 本地 ASR / 多人同时用 | 4C8G，20GB 磁盘 |
| 2 小时长片 | 不建议同步等；用分段/后台任务；磁盘至少 10GB 缓存余量 |
| GPU | 不需要（sherpa/SenseVoice ONNX 走 CPU） |

主要 CPU 开销是 ffmpeg 扫描（约 22–47× 实时），不是 ASR。10 分钟视频通常 20–40 秒扫描；云端 ASR 不占本地 CPU。

---

## B 站登录 / cookies

默认 `biliLoginEnabled: true`。插件启动时会：

1. 读取 `cookiesFile`（留空则 `dataDir/cookies.txt`）；
2. 请求 `nav` 检查是否登录；
3. 没有/已失效 → 在控制台打印二维码；
4. 手机 B 站扫码确认 → 自动写 Netscape `cookies.txt` + `bili-session.json`；
5. 之后 yt-dlp 直接使用这个文件。

登录成功后默认每 6 小时检查一次。若 `cookie/info` 说需要刷新，会用 `refresh_token` 走官方刷新流程（RSA correspond → `cookie/refresh` → `confirm/refresh`），不需要重新扫码；刷新失败或过期才重新出二维码。

控制台二维码：

- systemd 运行时用 `journalctl -u koishi -f` 查看；二维码是 ASCII，手机直接扫屏幕/日志即可。
- 二维码约 3 分钟有效；`biliQrTimeoutSec` 控制等待，过期自动重新生成，最多 `biliQrMaxRefresh` 次。
- 如果日志系统把二维码缩进弄乱，建议手动导出 cookies 并设 `biliLoginEnabled: false`。

手动 cookies（可选）：

1. 浏览器登录 B 站，用 **Cookie-Editor** 或 **Get cookies.txt LOCALLY** 导出 **Netscape** 格式。
2. 保存到 `cookiesFile`，`chmod 600 cookies.txt`。
3. `biliLoginEnabled: false` 可关闭自动登录，只用这份文件。

说明：

- `SESSDATA` 等同登录凭证；`cookies.txt` 和 `bili-session.json` 都会以 600 权限写入，**不要提交到 Git**。
- 匿名通常最高 480P；1080P 和 CC 字幕需要登录。
- 本插件不会用 cookies 发评论、点赞、投币，只做读取。

---

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 可执行文件路径；在 PATH 中可留默认 |
| `ytdlpPath` | 空 | 留空自动在 PATH 与 pip 脚本目录查找 |
| `cookiesFile` | 空 | Netscape cookies.txt 路径；留空=自动使用 `dataDir/cookies.txt`（扫码登录维护） |
| `dataDir` | `data/chatluna-video` | 缓存、媒体、cell 表目录 |
| `mediaMaxMB` | 300 | 视频缓存上限；超限按最久未用删除 |
| `maxDurationSec` | 600 | 单次 storyboard 时长上限 |
| `maxCells` | 9 | 单张宫格最多几格 |
| `maxZoomCells` | 6 | zoom 单张最多几格 |
| `maxConcurrent` | 1 | 同时扫描的视频数 |
| `frameConcurrency` | 2 | 单次取帧的 ffmpeg 并发 |
| `progress` | true | 是否发“正在解析/下载/扫描”提示 |
| `sendSheetToChat` | false | 是否把宫格图也发到聊天里 |
| `imageModel` | 无 | 主模型不支持图片时的转述模型，如 `qwen/qwen3.8-flash` |
| `advancedImage` | false | 是否展开高级图片参数；关闭时下面 4 项在控制台隐藏 |
| `imageMaxEdge` | 1280 | 注入模型前图片最长边；越小请求体越小 |
| `imageQuality` | 3 | JPEG 质量（ffmpeg qscale，2 最好、31 最差） |
| `maxRequestImageMB` | 2.5 | 单次注入图片的 base64 总大小上限（MB） |
| `maxImagesPerRequest` | 2 | 单轮最多注入几张工具图，防止并行 zoom 撑爆请求体 |
| `allowedGroups` | `[]` | 允许使用的群号；留空不限制；私聊不受限 |
| `biliLoginEnabled` | true | 启动检查 cookies，缺失/失效时控制台二维码登录 |
| `biliCookieCheckMinutes` | 360 | 每隔多少分钟检查 cookies/刷新 |
| `biliQrTimeoutSec` | 180 | 一次二维码登录的等待上限（秒） |
| `biliQrMaxRefresh` | 3 | 二维码过期后最多重新生成几次 |
| `biliRefreshToken` | true | 到期时用 refresh_token 自动刷新，失败回退二维码 |
| `asrEnabled` | true | 是否启用台词层 |
| `asrOnAiSubtitle` | true | B 站 AI 字幕（`ai-zh`）是否用 ASR 重跑；ASR 不可用/失败时自动回退 AI 字幕 |
| `asrBaseUrl` | SiliconFlow | OpenAI 兼容 `/audio/transcriptions`；MiMo 自动切 `/chat/completions` |
| `asrApiKey` | 空 | 云端必填；本机端点可空 |
| `asrModel` | SenseVoiceSmall | 服务端实际模型名 |
| `asrLanguage` | `zh` | 语言代码 |
| `asrHotwords` | 空 | 全局热词；跨学科内容建议留空 |

---

## 实现说明

```text
视频 URL / 本地文件
  → B站登录管理器：nav 检查 / 二维码登录 / refresh_token 刷新
  → ffprobe 探测
  → yt-dlp 下载低清全片（仅链接模式；缓存）
  → ffmpeg 64×36 HSV 帧差扫描 + 密度规划
  → 段内 3 候选帧按 Laplacian 方差取最锐
  → 拼成一张带编号宫格（可选底部音频包络）
  → 站点 CC / 内嵌字幕 / ASR
  → formatForDetail 生成文本清单
  → PNG base64 注入 ChatLuna 上下文
  → 模型下一轮看图回答
```

核心管线来自 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)（Apache-2.0），本插件使用带 AI 字幕/MiMo 补丁的 fork `dsh-video-storyboard-patched`。本插件只做 Koishi/ChatLuna 宿主胶水、配置、图片注入、QQ 限流与错误文案。

---

## 常见问题

### `找不到 yt-dlp`

安装 yt-dlp，或在配置里填 `ytdlpPath`。本地视频不需要 yt-dlp。

### 控制台没有二维码 / 二维码乱码

确认 `biliLoginEnabled: true`，并看 `journalctl -u koishi -f` 或日志文件里的 ASCII 二维码。日志系统如果把缩进弄乱，可手动导出 cookies 并设 `biliLoginEnabled: false`。

### 扫码显示成功，但工具仍匿名

检查 `cookiesFile` 是否存在、是否包含 `SESSDATA`；yt-dlp 只读这个 Netscape 文件。也可能是 B 站风控，稍后重试或重新扫码。

### `HTTP Error 567` / `412`

B 站风控/限流。567 通常要登录 cookies；412 等几十秒再试。不要连续重复调用。

### `413 Request Entity Too Large`

不是上下文 token 超限，而是模型网关的**请求体字节**超限。典型触发：同一轮并行调用两次 `video_zoom`，每张 PNG 约 2.1–2.3MB，base64 后两张合计约 5.6MB。

插件已内置处理：

- 注入前统一转 JPEG，最长边 1280、q=3；
- 单轮最多注入 `maxImagesPerRequest`（默认 2）张；
- 总 base64 超过 `maxRequestImageMB`（默认 2.5MB）会降质/缩图，仍超则只保留第一张。

如果仍报 413，继续调低：

```yaml
imageMaxEdge: 1024
imageQuality: 5
maxRequestImageMB: 2
maxImagesPerRequest: 1
```

### `transcript="no-key"`

ASR 开启了但云端没有 key，或本机端点不可达。填 `asrApiKey`，或把 `asrBaseUrl` 指向本地服务。

### `transcript="asr-failed"`

ASR 请求失败。看清单里的错误；检查 `asrBaseUrl`、key、模型名、网络。此时宫格图仍然会出，只是没有台词。

特别注意：`https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit` 是火山 BigModel 的异步 submit 接口，不是 OpenAI 兼容端点；插件会请求 `.../submit/audio/transcriptions` 并得到 404。需要换成 SiliconFlow、本地 FunASR/sherpa，或自己加一个 OpenAI 兼容代理。

### `当前模型不支持图片输入`

主模型没有 `ImageInput` 能力。换支持图像的模型，或配置 `imageModel: qwen/qwen3.8-flash` 走转述（细节会下降）。

### 视频太长

默认上限 10 分钟。用 `video_storyboard({ input, from: 0, segment: 300 })` 分段；结果末尾会给下一段的 `from`。

### QQ 分享卡片识别不到

当前 MVP 支持纯文本链接。QQ 分享卡片可能把 URL 放在 `json` 元素里，模型看不到；请先把链接复制成纯文本发送。后续可加 `messageTransformer` 解析卡片/视频元素。

### 图片太大 / 模型报请求体过大

调低 `maxCells`（如 6），或把 `imageModel`/主模型换成支持更大图片的；上游默认 1.2M 像素，一般没问题。

---

## 开发

```bash
cd koishi-app
yarn workspace koishi-plugin-chatluna-video-storyboard build
```

源码结构：

```text
src/
  index.ts          # 注册三个工具 + 启动自检
  config.ts         # Koishi 配置
  upstream.ts       # 动态加载 dsh-video-storyboard-patched，映射 env/参数
  bili-cookie.ts    # B站二维码登录 / cookies 校验 / refresh_token 刷新
  cell-store.ts     # cellId -> from/to 持久化
  inject.ts         # 图片注入 / imageModel 兜底
  utils.ts          # SSRF 防护、错误文案、并发闸门
  tools/
    probe.ts
    storyboard.ts
    zoom.ts
```

烟测脚本在仓库的 `.research/poc/plugin-smoke.cjs`（需要工作区 fixture 和 ffmpeg）；B站登录/刷新可用 `yarn workspace koishi-plugin-chatluna-video-storyboard test:login`（mock fetch，不需要真实账号）。正式使用时不需要。

---

## 许可与署名

- 本插件代码：MIT，LICENSE 已随包发布。
- 上游 fork `dsh-video-storyboard-patched`：基于 SAOS-3624 的 `dsh-video-storyboard`，Apache-2.0；fork 的 LICENSE/NOTICE/CREDITS 随独立 npm 包发布，插件包的 `THIRD_PARTY_NOTICES.md` 也做了署名。
- `qrcode-terminal`：Apache-2.0，作为普通 npm 依赖安装，许可证随其包发布。
- ffmpeg、yt-dlp、ASR 模型/服务各自遵循其许可证；本插件不打包它们。
- 请只处理你有权访问的视频；下载/转写行为需遵守站点条款与当地法律。