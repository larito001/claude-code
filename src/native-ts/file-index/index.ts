/**
 * vendor/file-index-src（Rust NAPI模块）的纯TypeScript移植。
 *
 * 原生模块封装了nucleo（https://github.com/helix-editor/nucleo）以实现高性能模糊文件搜索。该移植重新实现了相同的API和评分行为，无需原生依赖。
 *
 * 关键API：
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void   — 去重 + 建立路径索引
 *   .search(query: string, limit: number): SearchResult[]
 *
 * 评分语义：分数越低越好。分数是结果中的位置/结果数量，所以最佳匹配为0.0。包含"test"的路径获得1.05倍惩罚（上限1.0），因此非测试文件排名略高。
 */

export type SearchResult = {
  path: string
  score: number
}

// nucleo风格的评分常量（近似fzf-v2 / nucleo奖励）
const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const BONUS_FIRST_CHAR = 8
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

const TOP_LEVEL_CACHE_LIMIT = 100
const MAX_QUERY_LEN = 64
// 在此同步工作毫秒数后让出事件循环。块大小基于时间（而非基于数量），因此慢速机器获得更小的块并保持响应——在M系列上5k路径约2ms，但在较旧的Windows硬件上可能超过15ms。
const CHUNK_MS = 4

// 可复用缓冲区：记录在indexOf扫描期间每个搜索字符匹配的位置。
const posBuf = new Int32Array(MAX_QUERY_LEN)

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Uint16Array = new Uint16Array(0)
  private topLevelCache: SearchResult[] | null = null
  // 在异步构建期间，跟踪有多少路径已填充bitmap/lowerPath。search()使用此信息在构建继续时搜索已准备好的前缀。
  private readyCount = 0

  /** 从字符串数组加载路径。这是填充索引的主要方式——ripgrep收集文件，我们只需搜索它们。自动去重路径。 */
  loadFromFileList(fileList: string[]): void {
    // 去重并过滤空字符串（匹配Rust HashSet行为）
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }

    this.buildIndex(paths)
  }

  /**
   * 异步变体：每~8–12k路径让出事件循环，以便大索引（270k+文件）不会一次阻塞主线程超过10ms。与loadFromFileList结果相同。
   *
   * 返回 { queryable, done }:
   *   - queryable: 在第一个块索引完成后立即解决（search返回部分结果）。对于270k路径列表，在路径数组可用后大约进行5–10ms的同步工作。
   *   - done: 在整个索引构建完成后解决。
   */
  loadFromFileListAsync(fileList: string[]): {
    queryable: Promise<void>
    done: Promise<void>
  } {
    /** 执行 mark Queryable 对应的业务处理。 */
    let markQueryable: () => void = () => {}
    const queryable = new Promise<void>(resolve => {
      markQueryable = resolve
    })
    const done = this.buildAsync(fileList, markQueryable)
    return { queryable, done }
  }

  /** 创建 build Async 对应的数据或状态。 */
  private async buildAsync(
    fileList: string[],
    markQueryable: () => void,
  ): Promise<void> {
    const seen = new Set<string>()
    const paths: string[] = []
    let chunkStart = performance.now()
    for (let i = 0; i < fileList.length; i++) {
      const line = fileList[i]!
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
      // 每256次迭代检查一次以分摊performance.now()开销
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }

    this.resetArrays(paths)

    chunkStart = performance.now()
    let firstChunk = true
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
      if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
        this.readyCount = i + 1
        if (firstChunk) {
          markQueryable()
          firstChunk = false
        }
        await yieldToEventLoop()
        chunkStart = performance.now()
      }
    }
    this.readyCount = paths.length
    markQueryable()
  }

  /** 创建 build Index 对应的数据或状态。 */
  private buildIndex(paths: string[]): void {
    this.resetArrays(paths)
    for (let i = 0; i < paths.length; i++) {
      this.indexPath(i)
    }
    this.readyCount = paths.length
  }

  /** 重置或恢复 reset Arrays 对应的数据或状态。 */
  private resetArrays(paths: string[]): void {
    const n = paths.length
    this.paths = paths
    this.lowerPaths = new Array(n)
    this.charBits = new Int32Array(n)
    this.pathLens = new Uint16Array(n)
    this.readyCount = 0
    this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT)
  }

  // 预计算：小写、a–z位图、长度。位图提供O(1)拒绝缺少任何搜索字母的路径的能力（对于类似"test"的宽泛查询，89%存活率——仍然有10%以上的免费胜利；对于稀有字符，90%以上的拒绝率）。
  private indexPath(i: number): void {
    const lp = this.paths[i]!.toLowerCase()
    this.lowerPaths[i] = lp
    const len = lp.length
    this.pathLens[i] = len
    let bits = 0
    for (let j = 0; j < len; j++) {
      const c = lp.charCodeAt(j)
      if (c >= 97 && c <= 122) bits |= 1 << (c - 97)
    }
    this.charBits[i] = bits
  }

  /** 使用模糊匹配搜索与查询匹配的文件。返回按匹配分数排序的前N个结果。 */
  search(query: string, limit: number): SearchResult[] {
    if (limit <= 0) return []
    if (query.length === 0) {
      if (this.topLevelCache) {
        return this.topLevelCache.slice(0, limit)
      }
      return []
    }

    // 智能大小写：小写查询→不区分大小写；任何大写→区分大小写
    const caseSensitive = query !== query.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    const nLen = Math.min(needle.length, MAX_QUERY_LEN)
    const needleChars: string[] = new Array(nLen)
    let needleBitmap = 0
    for (let j = 0; j < nLen; j++) {
      const ch = needle.charAt(j)
      needleChars[j] = ch
      const cc = ch.charCodeAt(0)
      if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97)
    }

    // 假设每个匹配都获得最大边界奖励的分数上限。用于在charCodeAt繁重的边界传递之前，拒绝那些仅靠间隙惩罚就无法超过当前top-k阈值的路径。
    const scoreCeiling =
      nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32

    // Top-k：维护一个升序排序的最佳`limit`匹配数组。当我们只需要其中的`limit`个时，避免对所有匹配进行O(n log n)排序。
    const topK: { path: string; fuzzScore: number }[] = []
    let threshold = -Infinity

    const { paths, lowerPaths, charBits, pathLens, readyCount } = this

    outer: for (let i = 0; i < readyCount; i++) {
      // O(1)位图拒绝：路径必须包含搜索中的每个字母
      if ((charBits[i]! & needleBitmap) !== needleBitmap) continue

      const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!

      // 融合的indexOf扫描：查找位置（在JSC/V8中SIMD加速）并内联累加间隙/连续项。此处找到的贪婪最早位置与charCodeAt评分器找到的位置相同，因此我们直接从中评分——无需第二次扫描。
      let pos = haystack.indexOf(needleChars[0]!)
      if (pos === -1) continue
      posBuf[0] = pos
      let gapPenalty = 0
      let consecBonus = 0
      let prev = pos
      for (let j = 1; j < nLen; j++) {
        pos = haystack.indexOf(needleChars[j]!, prev + 1)
        if (pos === -1) continue outer
        posBuf[j] = pos
        const gap = pos - prev - 1
        if (gap === 0) consecBonus += BONUS_CONSECUTIVE
        else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
        prev = pos
      }

      // 间隙边界拒绝：如果最佳情况分数（所有边界奖励）减去已知间隙惩罚无法超过阈值，则跳过边界传递。
      if (
        topK.length === limit &&
        scoreCeiling + consecBonus - gapPenalty <= threshold
      ) {
        continue
      }

      // 边界/驼峰命名法评分：检查每个匹配位置之前的字符。
      const path = paths[i]!
      const hLen = pathLens[i]!
      let score = nLen * SCORE_MATCH + consecBonus - gapPenalty
      score += scoreBonusAt(path, posBuf[0]!, true)
      for (let j = 1; j < nLen; j++) {
        score += scoreBonusAt(path, posBuf[j]!, false)
      }
      score += Math.max(0, 32 - (hLen >> 2))

      if (topK.length < limit) {
        topK.push({ path, fuzzScore: score })
        if (topK.length === limit) {
          topK.sort((a, b) => a.fuzzScore - b.fuzzScore)
          threshold = topK[0]!.fuzzScore
        }
      } else if (score > threshold) {
        let lo = 0
        let hi = topK.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (topK[mid]!.fuzzScore < score) lo = mid + 1
          else hi = mid
        }
        topK.splice(lo, 0, { path, fuzzScore: score })
        topK.shift()
        threshold = topK[0]!.fuzzScore
      }
    }

    // topK是升序；反转以降序（最佳优先）
    topK.sort((a, b) => b.fuzzScore - a.fuzzScore)

    const matchCount = topK.length
    const denom = Math.max(matchCount, 1)
    const results: SearchResult[] = new Array(matchCount)

    for (let i = 0; i < matchCount; i++) {
      const path = topK[i]!.path
      const positionScore = i / denom
      const finalScore = path.includes('test')
        ? Math.min(positionScore * 1.05, 1.0)
        : positionScore
      results[i] = { path, score: finalScore }
    }

    return results
  }
}

/** 针对原始大小写路径中位置`pos`的匹配的边界/驼峰命名法奖励。`first`启用字符串起始奖励（仅适用于needle[0]）。 */
function scoreBonusAt(path: string, pos: number, first: boolean): number {
  if (pos === 0) return first ? BONUS_FIRST_CHAR : 0
  const prevCh = path.charCodeAt(pos - 1)
  if (isBoundary(prevCh)) return BONUS_BOUNDARY
  if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL
  return 0
}

/** 判断是否满足 is Boundary 对应的数据或状态。 */
function isBoundary(code: number): boolean {
  // / \\ - _ . 空格
  return (
    code === 47 || // /
    code === 92 || // \
    code === 45 || // -
    code === 95 || // _
    code === 46 || // .
    code === 32 // 空格
  )
}

/** 判断是否满足 is Lower 对应的数据或状态。 */
function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}

/** 判断是否满足 is Upper 对应的数据或状态。 */
function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}

/** 执行 yield To Event Loop 对应的业务处理。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

export { CHUNK_MS }

/**
 * 提取唯一的顶级路径段，按（长度升序，然后按字母升序）排序。处理Unix（/）和Windows（\）路径分隔符。镜像lib.rs中的FileIndex::compute_top_level_entries。
 */
function computeTopLevelEntries(
  paths: string[],
  limit: number,
): SearchResult[] {
  const topLevel = new Set<string>()

  for (const p of paths) {
    // 在第一个/或\分隔符处分割
    let end = p.length
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i)
      if (c === 47 || c === 92) {
        end = i
        break
      }
    }
    const segment = p.slice(0, end)
    if (segment.length > 0) {
      topLevel.add(segment)
      if (topLevel.size >= limit) break
    }
  }

  const sorted = Array.from(topLevel)
  sorted.sort((a, b) => {
    const lenDiff = a.length - b.length
    if (lenDiff !== 0) return lenDiff
    return a < b ? -1 : a > b ? 1 : 0
  })

  return sorted.slice(0, limit).map(path => ({ path, score: 0.0 }))
}

export default FileIndex
export type { FileIndex as FileIndexType }
