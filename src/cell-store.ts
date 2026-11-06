import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface CellRecord {
  at: number
  cells: Array<{ i: number; from: number; to: number }>
}

type Store = Record<string, CellRecord>

const FILE = 'cells.json'
const MAX_FILES = 32

const norm = (value: string | undefined | null) =>
  String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase()

/**
 * 自己的 cell 表：上游 0.5.4 的 `lookupCell` 没有从 package exports 暴露，
 * 所以这里在每次 storyboard 后记录 `cellId -> from/to`，供 video_zoom 使用。
 * 同时用原始 input 与下载后的本地路径做别名，模型传 URL 或本地路径都能查到。
 */
export class CellStore {
  private data: Store = {}
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private path() {
    return join(this.dir, FILE)
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.path(), 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) this.data = raw
    } catch {
      this.data = {}
    }
  }

  async save(
    input: string,
    localPath: string | undefined,
    cells: Array<{ i: number; t_start: number; t_end: number }>,
  ) {
    if (!cells.length) return
    await this.load()
    const aliases = [...new Set([norm(input), norm(localPath)].filter(Boolean))]
    if (!aliases.length) return

    const record: CellRecord = {
      at: Date.now(),
      cells: cells.map((cell) => ({
        i: Number(cell.i),
        from: +Number(cell.t_start).toFixed(3),
        to: +Number(cell.t_end).toFixed(3),
      })),
    }

    for (const key of aliases) this.data[key] = record
    const keys = Object.keys(this.data).sort(
      (a, b) => (this.data[b]?.at ?? 0) - (this.data[a]?.at ?? 0),
    )
    for (const key of keys.slice(MAX_FILES)) delete this.data[key]

    this.writing = this.writing
      .then(async () => {
        await mkdir(this.dir, { recursive: true })
        await writeFile(this.path(), JSON.stringify(this.data), 'utf8')
      })
      .catch(() => {
        /* 写失败不影响出图；下次重新记录 */
      })
    await this.writing
  }

  async lookup(input: string, cellId: number): Promise<{ from: number; to: number } | null> {
    await this.load()
    const record = this.data[norm(input)]
    if (!record) return null
    const hit = record.cells.find((cell) => cell.i === Number(cellId))
    return hit ? { from: hit.from, to: hit.to } : null
  }
}