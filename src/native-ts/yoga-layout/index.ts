/**
 * yoga-layout（Meta的flexbox引擎）的纯TypeScript移植。
 *
 * 这与 src/ink/layout/yoga.ts 使用的 `yoga-layout/load` API 接口相匹配。
 * 上游 C++ 源码仅 CalculateLayout.cpp 就有约2500行；本移植是一个简化的单遍flexbox实现，涵盖了Ink实际使用的功能子集：
 *   - flex-direction（row/column + reverse）
 *   - flex-grow / flex-shrink / flex-basis
 *   - align-items / align-self（stretch, flex-start, center, flex-end）
 *   - justify-content（所有六个值）
 *   - margin / padding / border / gap
 *   - width / height / min / max（point, percent, auto）
 *   - position: relative / absolute
 *   - display: flex / none
 *   - 测量函数（用于文本节点）
 *
 * 同样为实现规范一致性而实现（Ink未使用）：
 *   - margin: auto（主轴+交叉轴，覆盖justify/align）
 *   - 当子元素命中min/max约束时的多遍flex夹紧
 *   - 当容器大小不确定时，根据容器min/max进行flex-grow/shrink
 *
 * 同样为实现规范一致性而实现（Ink未使用）：
 *   - flex-wrap: wrap / wrap-reverse（多行flex）
 *   - align-content（在交叉轴上定位换行行）
 *
 * 同样为实现规范一致性而实现（Ink未使用）：
 *   - display: contents（子元素提升到祖元素，移除盒子）
 *
 * 同样为实现规范一致性而实现（Ink未使用）：
 *   - 基线对齐（align-items/align-self: baseline）
 *
 * 未实现（Ink未使用）：
 *   - aspect-ratio
 *   - box-sizing: content-box
 *   - RTL 方向（Ink始终传递 Direction.LTR）
 *
 * 上游：https://github.com/facebook/yoga
 */

import {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from './enums.js'

export {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
}

// --
// 值类型

export type Value = {
  unit: Unit
  value: number
}

const UNDEFINED_VALUE: Value = { unit: Unit.Undefined, value: NaN }
const AUTO_VALUE: Value = { unit: Unit.Auto, value: NaN }

/** 执行 point Value 对应的业务处理。 */
function pointValue(v: number): Value {
  return { unit: Unit.Point, value: v }
}
/** 执行 percent Value 对应的业务处理。 */
function percentValue(v: number): Value {
  return { unit: Unit.Percent, value: v }
}

/** 确定 resolve Value 对应的数据或状态。 */
function resolveValue(v: Value, ownerSize: number): number {
  switch (v.unit) {
    case Unit.Point:
      return v.value
    case Unit.Percent:
      return isNaN(ownerSize) ? NaN : (v.value * ownerSize) / 100
    default:
      return NaN
  }
}

/** 判断是否满足 is Defined 对应的数据或状态。 */
function isDefined(n: number): boolean {
  return !isNaN(n)
}

// 对布局缓存输入比较的 NaN 安全相等性
function sameFloat(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b)
}

// --
// 布局结果（计算值）

type Layout = {
  left: number
  top: number
  width: number
  height: number
  // 计算的每边值（解析为物理边缘）
  border: [number, number, number, number] // 左、上、右、下
  padding: [number, number, number, number]
  margin: [number, number, number, number]
}

// --
// 样式（输入值）

type Style = {
  direction: Direction
  flexDirection: FlexDirection
  justifyContent: Justify
  alignItems: Align
  alignSelf: Align
  alignContent: Align
  flexWrap: Wrap
  overflow: Overflow
  display: Display
  positionType: PositionType

  flexGrow: number
  flexShrink: number
  flexBasis: Value

  // 由 Edge 枚举索引的 9 边数组
  margin: Value[]
  padding: Value[]
  border: Value[]
  position: Value[]

  // 由 Gutter 枚举索引的 3 间距数组
  gap: Value[]

  width: Value
  height: Value
  minWidth: Value
  minHeight: Value
  maxWidth: Value
  maxHeight: Value
}

/** 执行 default Style 对应的业务处理。 */
function defaultStyle(): Style {
  return {
    direction: Direction.Inherit,
    flexDirection: FlexDirection.Column,
    justifyContent: Justify.FlexStart,
    alignItems: Align.Stretch,
    alignSelf: Align.Auto,
    alignContent: Align.FlexStart,
    flexWrap: Wrap.NoWrap,
    overflow: Overflow.Visible,
    display: Display.Flex,
    positionType: PositionType.Relative,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: AUTO_VALUE,
    margin: new Array(9).fill(UNDEFINED_VALUE),
    padding: new Array(9).fill(UNDEFINED_VALUE),
    border: new Array(9).fill(UNDEFINED_VALUE),
    position: new Array(9).fill(UNDEFINED_VALUE),
    gap: new Array(3).fill(UNDEFINED_VALUE),
    width: AUTO_VALUE,
    height: AUTO_VALUE,
    minWidth: UNDEFINED_VALUE,
    minHeight: UNDEFINED_VALUE,
    maxWidth: UNDEFINED_VALUE,
    maxHeight: UNDEFINED_VALUE,
  }
}

// --
// 边缘解析 — yoga 的 9 边模型折叠为 4 个物理边缘

const EDGE_LEFT = 0
const EDGE_TOP = 1
const EDGE_RIGHT = 2
const EDGE_BOTTOM = 3

/** 确定 resolve Edge 对应的数据或状态。 */
function resolveEdge(
  edges: Value[],
  physicalEdge: number,
  ownerSize: number,
  // 对于边距/位置，我们允许 auto；对于内边距/边框，auto 解析为 0
  allowAuto = false,
): number {
  // 优先级：特定边 > 水平/垂直 > 所有
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) {
    v = edges[Edge.All]!
  }
  // Start/End 映射到 LTR 的 Left/Right（Ink 始终是 LTR）
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) v = edges[Edge.Start]!
    if (physicalEdge === EDGE_RIGHT) v = edges[Edge.End]!
  }
  if (v.unit === Unit.Undefined) return 0
  if (v.unit === Unit.Auto) return allowAuto ? NaN : 0
  return resolveValue(v, ownerSize)
}

/** 确定 resolve Edge Raw 对应的数据或状态。 */
function resolveEdgeRaw(edges: Value[], physicalEdge: number): Value {
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) v = edges[Edge.All]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) v = edges[Edge.Start]!
    if (physicalEdge === EDGE_RIGHT) v = edges[Edge.End]!
  }
  return v
}

/** 判断是否满足 is Margin Auto 对应的数据或状态。 */
function isMarginAuto(edges: Value[], physicalEdge: number): boolean {
  return resolveEdgeRaw(edges, physicalEdge).unit === Unit.Auto
}

// 用于 _hasAutoMargin / _hasPosition 快速路径标志的设置辅助方法。
// 单位枚举值：Unit.Undefined = 0，Unit.Auto = 3。
/** 判断是否满足 has Any Auto Edge 对应的数据或状态。 */
function hasAnyAutoEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit === 3) return true
  return false
}
/** 判断是否满足 has Any Defined Edge 对应的数据或状态。 */
function hasAnyDefinedEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit !== 0) return true
  return false
}

// 热路径：一次性解析所有 4 个物理边缘，写入 `out`。
// 相当于调用 resolveEdge() 4 次且 allowAuto=false，但提升了共享的回退查找（Horizontal/Vertical/All/Start/End），并避免每次 layoutNode() 调用都分配新的 4 元素数组。
function resolveEdges4Into(
  edges: Value[],
  ownerSize: number,
  out: [number, number, number, number],
): void {
  // 提升回退值一次——4 个每边链共享这些读取。
  const eH = edges[6]! // 水平边 Edge.Horizontal
  const eV = edges[7]! // 垂直边 Edge.Vertical
  const eA = edges[8]! // 全部边 Edge.All
  const eS = edges[4]! // 起始边 Edge.Start
  const eE = edges[5]! // 结束边 Edge.End
  const pctDenom = isNaN(ownerSize) ? NaN : ownerSize / 100

  // 左边：edges[0] → Horizontal → All → Start
  let v = edges[0]!
  if (v.unit === 0) v = eH
  if (v.unit === 0) v = eA
  if (v.unit === 0) v = eS
  out[0] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 上边：edges[1] → Vertical → All
  v = edges[1]!
  if (v.unit === 0) v = eV
  if (v.unit === 0) v = eA
  out[1] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 右边：edges[2] → Horizontal → All → End
  v = edges[2]!
  if (v.unit === 0) v = eH
  if (v.unit === 0) v = eA
  if (v.unit === 0) v = eE
  out[2] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 底部：edges[3] → 垂直 → 所有
  v = edges[3]!
  if (v.unit === 0) v = eV
  if (v.unit === 0) v = eA
  out[3] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0
}

// --
// 轴辅助

function isRow(dir: FlexDirection): boolean {
  return dir === FlexDirection.Row || dir === FlexDirection.RowReverse
}
/** 判断是否满足 is Reverse 对应的数据或状态。 */
function isReverse(dir: FlexDirection): boolean {
  return dir === FlexDirection.RowReverse || dir === FlexDirection.ColumnReverse
}
/** 执行 cross Axis 对应的业务处理。 */
function crossAxis(dir: FlexDirection): FlexDirection {
  return isRow(dir) ? FlexDirection.Column : FlexDirection.Row
}
/** 执行 leading Edge 对应的业务处理。 */
function leadingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_LEFT
    case FlexDirection.RowReverse:
      return EDGE_RIGHT
    case FlexDirection.Column:
      return EDGE_TOP
    case FlexDirection.ColumnReverse:
      return EDGE_BOTTOM
  }
}
/** 执行 trailing Edge 对应的业务处理。 */
function trailingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_RIGHT
    case FlexDirection.RowReverse:
      return EDGE_LEFT
    case FlexDirection.Column:
      return EDGE_BOTTOM
    case FlexDirection.ColumnReverse:
      return EDGE_TOP
  }
}

// --
// 公共类型

export type MeasureFunction = (
  width: number,
  widthMode: MeasureMode,
  height: number,
  heightMode: MeasureMode,
) => { width: number; height: number }

export type Size = { width: number; height: number }

// --
// 配置

export type Config = {
  pointScaleFactor: number
  errata: Errata
  useWebDefaults: boolean
  /** 执行 free 对应的业务处理。 */
  free(): void
  /** 判断是否满足 is Experimental Feature Enabled 对应的数据或状态。 */
  isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean
  /** 设置并保存 set Experimental Feature Enabled 对应的数据或状态。 */
  setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void
  /** 设置并保存 set Point Scale Factor 对应的数据或状态。 */
  setPointScaleFactor(factor: number): void
  /** 获取 get Errata 对应的数据或状态。 */
  getErrata(): Errata
  /** 设置并保存 set Errata 对应的数据或状态。 */
  setErrata(errata: Errata): void
  /** 设置并保存 set Use Web Defaults 对应的数据或状态。 */
  setUseWebDefaults(v: boolean): void
}

/** 创建 create Config 对应的数据或状态。 */
function createConfig(): Config {
  const config: Config = {
    pointScaleFactor: 1,
    errata: Errata.None,
    useWebDefaults: false,
    /** 执行 free 对应的业务处理。 */
    free() {},
    /** 判断是否满足 is Experimental Feature Enabled 对应的数据或状态。 */
    isExperimentalFeatureEnabled() {
      return false
    },
    /** 设置并保存 set Experimental Feature Enabled 对应的数据或状态。 */
    setExperimentalFeatureEnabled() {},
    /** 设置并保存 set Point Scale Factor 对应的数据或状态。 */
    setPointScaleFactor(f) {
      config.pointScaleFactor = f
    },
    /** 获取 get Errata 对应的数据或状态。 */
    getErrata() {
      return config.errata
    },
    /** 设置并保存 set Errata 对应的数据或状态。 */
    setErrata(e) {
      config.errata = e
    },
    /** 设置并保存 set Use Web Defaults 对应的数据或状态。 */
    setUseWebDefaults(v) {
      config.useWebDefaults = v
    },
  }
  return config
}

// --
// 节点实现

export class Node {
  style: Style
  layout: Layout
  parent: Node | null
  children: Node[]
  measureFunc: MeasureFunction | null
  config: Config
  isDirty_: boolean
  isReferenceBaseline_: boolean

  // 每个布局的暂存空间（非公共API）
  _flexBasis = 0
  _mainSize = 0
  _crossSize = 0
  _lineIndex = 0
  // 由样式设置器维护的快速路径标志。根据CPU分析，定位循环每个子节点每次布局遍历调用`isMarginAuto` 6次、`resolveEdgeRaw(position)` 4次——1000节点基准测试约11000次调用，几乎所有调用都返回false/undefined，因为大多数节点没有自动边距和位置内偏移。这些标志让我们只需一个分支就跳到常见情况。
  _hasAutoMargin = false
  _hasPosition = false
  // 对于每个`layoutNode()`顶部的三次`resolveEdges4Into`调用也是同样的模式。在1000节点基准测试中，约67%的这些调用操作的边数组全部为未定义（大多数节点没有边框；只有列有内边距；只有叶子单元格有外边距）——一个分支跳过比~20次属性读取+~15次比较+4次写入零更好。
  _hasPadding = false
  _hasBorder = false
  _hasMargin = false
  // 脏标志布局缓存。镜像上游CalculateLayout.cpp的layoutNodeInternal：当子树干净且我们问的问题与缓存答案相同时，完全跳过该子树。使用两个插槽，因为每个节点通常先看到一次measure调用（performLayout=false，来自computeFlexBasis），然后是一次layout调用（performLayout=true），每次父级遍历的输入不同——单个插槽会抖动。使用此方案后，重新布局基准测试（将一个叶子置脏，重新计算根节点）从2.7倍降到1.1倍：干净的兄弟节点直接跳过，只有脏链条重新计算。
  _lW = NaN
  _lH = NaN
  _lWM: MeasureMode = 0
  _lHM: MeasureMode = 0
  _lOW = NaN
  _lOH = NaN
  _lFW = false
  _lFH = false
  // `_hasL`早期（计算前）存储输入，但layout.width/height会被多条目缓存和后续不同输入的compute调用改变。如果不存储输出，`_hasL`命中会返回上次调用留下的任意layout.width/height——导致scrollbox vpH=33→2624的错误。像多条目缓存那样存储并恢复输出。
  _lOutW = NaN
  _lOutH = NaN
  _hasL = false
  _mW = NaN
  _mH = NaN
  _mWM: MeasureMode = 0
  _mHM: MeasureMode = 0
  _mOW = NaN
  _mOH = NaN
  _mOutW = NaN
  _mOutH = NaN
  _hasM = false
  // 缓存的computeFlexBasis结果。对于干净的子节点，基准只依赖于容器的内部尺寸——如果这些尺寸没有改变，则完全跳过layoutNode(performLayout=false)递归。这是滚动的热路径：500条消息的内容容器是脏的，其499个干净子节点每个被测量约20次，因为脏链条的测量/布局传递级联。基准缓存在子节点边界短路。
  _fbBasis = NaN
  _fbOwnerW = NaN
  _fbOwnerH = NaN
  _fbAvailMain = NaN
  _fbAvailCross = NaN
  _fbCrossMode: MeasureMode = 0
  // 写入`_fbBasis`时的世代。来自先前世代的脏节点拥有过时的缓存（子树已更改），但在同一世代内，缓存是新鲜的——脏链条的measure→layout级联在刚挂载的条目上每次calculateLayout调用computeFlexBasis ≥2^depth次，且调用间子树不变。基于世代而非isDirty_进行门控，使得刚挂载的条目（虚拟滚动）在第一次计算后缓存命中：10.5万次访问减少到约1万次。
  _fbGen = -1
  // 多条目布局缓存——存储（输入 → 计算后的宽高），因此与`_hasL`不同输入的命中可以恢复正确的尺寸。上游yoga使用16个；4个覆盖Ink的脏链条深度。打包为扁平数组以避免每个条目的对象分配。插槽i使用`_cIn`中索引[i*8, i*8+8)（aW,aH,wM,hM,oW,oH,fW,fH）和`_cOut`中索引[i*2, i*2+2)（w,h）。
  _cIn: Float64Array | null = null
  _cOut: Float64Array | null = null
  _cGen = -1
  _cN = 0
  _cWr = 0

  /** 初始化当前实例及其必要状态。 */
  constructor(config?: Config) {
    this.style = defaultStyle()
    this.layout = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
    }
    this.parent = null
    this.children = []
    this.measureFunc = null
    this.config = config ?? DEFAULT_CONFIG
    this.isDirty_ = true
    this.isReferenceBaseline_ = false
    _yogaLiveNodes++
  }

  // -- 树

  insertChild(child: Node, index: number): void {
    child.parent = this
    this.children.splice(index, 0, child)
    this.markDirty()
  }
  /** 删除或清理 remove Child 对应的数据或状态。 */
  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx >= 0) {
      this.children.splice(idx, 1)
      child.parent = null
      this.markDirty()
    }
  }
  /** 获取 get Child 对应的数据或状态。 */
  getChild(index: number): Node {
    return this.children[index]!
  }
  /** 获取 get Child Count 对应的数据或状态。 */
  getChildCount(): number {
    return this.children.length
  }
  /** 获取 get Parent 对应的数据或状态。 */
  getParent(): Node | null {
    return this.parent
  }

  // -- 生命周期

  free(): void {
    this.parent = null
    this.children = []
    this.measureFunc = null
    this._cIn = null
    this._cOut = null
    _yogaLiveNodes--
  }
  /** 执行 free Recursive 对应的业务处理。 */
  freeRecursive(): void {
    for (const c of this.children) c.freeRecursive()
    this.free()
  }
  /** 重置或恢复 reset 对应的数据或状态。 */
  reset(): void {
    this.style = defaultStyle()
    this.children = []
    this.parent = null
    this.measureFunc = null
    this.isDirty_ = true
    this._hasAutoMargin = false
    this._hasPosition = false
    this._hasPadding = false
    this._hasBorder = false
    this._hasMargin = false
    this._hasL = false
    this._hasM = false
    this._cN = 0
    this._cWr = 0
    this._fbBasis = NaN
  }

  // -- 脏状态跟踪

  markDirty(): void {
    this.isDirty_ = true
    if (this.parent && !this.parent.isDirty_) this.parent.markDirty()
  }
  /** 判断是否满足 is Dirty 对应的数据或状态。 */
  isDirty(): boolean {
    return this.isDirty_
  }
  /** 判断是否满足 has New Layout 对应的数据或状态。 */
  hasNewLayout(): boolean {
    return true
  }
  /** 执行 mark Layout Seen 对应的业务处理。 */
  markLayoutSeen(): void {}

  // -- 测量函数

  setMeasureFunc(fn: MeasureFunction | null): void {
    this.measureFunc = fn
    this.markDirty()
  }
  /** 执行 unset Measure Func 对应的业务处理。 */
  unsetMeasureFunc(): void {
    this.measureFunc = null
    this.markDirty()
  }

  // -- 计算布局获取器

  getComputedLeft(): number {
    return this.layout.left
  }
  /** 获取 get Computed Top 对应的数据或状态。 */
  getComputedTop(): number {
    return this.layout.top
  }
  /** 获取 get Computed Width 对应的数据或状态。 */
  getComputedWidth(): number {
    return this.layout.width
  }
  /** 获取 get Computed Height 对应的数据或状态。 */
  getComputedHeight(): number {
    return this.layout.height
  }
  /** 获取 get Computed Right 对应的数据或状态。 */
  getComputedRight(): number {
    const p = this.parent
    return p ? p.layout.width - this.layout.left - this.layout.width : 0
  }
  /** 获取 get Computed Bottom 对应的数据或状态。 */
  getComputedBottom(): number {
    const p = this.parent
    return p ? p.layout.height - this.layout.top - this.layout.height : 0
  }
  /** 获取 get Computed Layout 对应的数据或状态。 */
  getComputedLayout(): {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  } {
    return {
      left: this.layout.left,
      top: this.layout.top,
      right: this.getComputedRight(),
      bottom: this.getComputedBottom(),
      width: this.layout.width,
      height: this.layout.height,
    }
  }
  /** 获取 get Computed Border 对应的数据或状态。 */
  getComputedBorder(edge: Edge): number {
    return this.layout.border[physicalEdge(edge)]!
  }
  /** 获取 get Computed Padding 对应的数据或状态。 */
  getComputedPadding(edge: Edge): number {
    return this.layout.padding[physicalEdge(edge)]!
  }
  /** 获取 get Computed Margin 对应的数据或状态。 */
  getComputedMargin(edge: Edge): number {
    return this.layout.margin[physicalEdge(edge)]!
  }

  // -- 样式设置器：尺寸

  setWidth(v: number | 'auto' | string | undefined): void {
    this.style.width = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Width Percent 对应的数据或状态。 */
  setWidthPercent(v: number): void {
    this.style.width = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Width Auto 对应的数据或状态。 */
  setWidthAuto(): void {
    this.style.width = AUTO_VALUE
    this.markDirty()
  }
  /** 设置并保存 set Height 对应的数据或状态。 */
  setHeight(v: number | 'auto' | string | undefined): void {
    this.style.height = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Height Percent 对应的数据或状态。 */
  setHeightPercent(v: number): void {
    this.style.height = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Height Auto 对应的数据或状态。 */
  setHeightAuto(): void {
    this.style.height = AUTO_VALUE
    this.markDirty()
  }
  /** 设置并保存 set Min Width 对应的数据或状态。 */
  setMinWidth(v: number | string | undefined): void {
    this.style.minWidth = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Min Width Percent 对应的数据或状态。 */
  setMinWidthPercent(v: number): void {
    this.style.minWidth = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Min Height 对应的数据或状态。 */
  setMinHeight(v: number | string | undefined): void {
    this.style.minHeight = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Min Height Percent 对应的数据或状态。 */
  setMinHeightPercent(v: number): void {
    this.style.minHeight = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Max Width 对应的数据或状态。 */
  setMaxWidth(v: number | string | undefined): void {
    this.style.maxWidth = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Max Width Percent 对应的数据或状态。 */
  setMaxWidthPercent(v: number): void {
    this.style.maxWidth = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Max Height 对应的数据或状态。 */
  setMaxHeight(v: number | string | undefined): void {
    this.style.maxHeight = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Max Height Percent 对应的数据或状态。 */
  setMaxHeightPercent(v: number): void {
    this.style.maxHeight = percentValue(v)
    this.markDirty()
  }

  // -- 样式设置器：flex

  setFlexDirection(dir: FlexDirection): void {
    this.style.flexDirection = dir
    this.markDirty()
  }
  /** 设置并保存 set Flex Grow 对应的数据或状态。 */
  setFlexGrow(v: number | undefined): void {
    this.style.flexGrow = v ?? 0
    this.markDirty()
  }
  /** 设置并保存 set Flex Shrink 对应的数据或状态。 */
  setFlexShrink(v: number | undefined): void {
    this.style.flexShrink = v ?? 0
    this.markDirty()
  }
  /** 设置并保存 set Flex 对应的数据或状态。 */
  setFlex(v: number | undefined): void {
    if (v === undefined || isNaN(v)) {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    } else if (v > 0) {
      this.style.flexGrow = v
      this.style.flexShrink = 1
      this.style.flexBasis = pointValue(0)
    } else if (v < 0) {
      this.style.flexGrow = 0
      this.style.flexShrink = -v
    } else {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    }
    this.markDirty()
  }
  /** 设置并保存 set Flex Basis 对应的数据或状态。 */
  setFlexBasis(v: number | 'auto' | string | undefined): void {
    this.style.flexBasis = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Flex Basis Percent 对应的数据或状态。 */
  setFlexBasisPercent(v: number): void {
    this.style.flexBasis = percentValue(v)
    this.markDirty()
  }
  /** 设置并保存 set Flex Basis Auto 对应的数据或状态。 */
  setFlexBasisAuto(): void {
    this.style.flexBasis = AUTO_VALUE
    this.markDirty()
  }
  /** 设置并保存 set Flex Wrap 对应的数据或状态。 */
  setFlexWrap(wrap: Wrap): void {
    this.style.flexWrap = wrap
    this.markDirty()
  }

  // -- 样式设置器：对齐

  setAlignItems(a: Align): void {
    this.style.alignItems = a
    this.markDirty()
  }
  /** 设置并保存 set Align Self 对应的数据或状态。 */
  setAlignSelf(a: Align): void {
    this.style.alignSelf = a
    this.markDirty()
  }
  /** 设置并保存 set Align Content 对应的数据或状态。 */
  setAlignContent(a: Align): void {
    this.style.alignContent = a
    this.markDirty()
  }
  /** 设置并保存 set Justify Content 对应的数据或状态。 */
  setJustifyContent(j: Justify): void {
    this.style.justifyContent = j
    this.markDirty()
  }

  // -- 样式设置器：显示/定位/溢出

  setDisplay(d: Display): void {
    this.style.display = d
    this.markDirty()
  }
  /** 获取 get Display 对应的数据或状态。 */
  getDisplay(): Display {
    return this.style.display
  }
  /** 设置并保存 set Position Type 对应的数据或状态。 */
  setPositionType(t: PositionType): void {
    this.style.positionType = t
    this.markDirty()
  }
  /** 设置并保存 set Position 对应的数据或状态。 */
  setPosition(edge: Edge, v: number | string | undefined): void {
    this.style.position[edge] = parseDimension(v)
    this._hasPosition = hasAnyDefinedEdge(this.style.position)
    this.markDirty()
  }
  /** 设置并保存 set Position Percent 对应的数据或状态。 */
  setPositionPercent(edge: Edge, v: number): void {
    this.style.position[edge] = percentValue(v)
    this._hasPosition = true
    this.markDirty()
  }
  /** 设置并保存 set Position Auto 对应的数据或状态。 */
  setPositionAuto(edge: Edge): void {
    this.style.position[edge] = AUTO_VALUE
    this._hasPosition = true
    this.markDirty()
  }
  /** 设置并保存 set Overflow 对应的数据或状态。 */
  setOverflow(o: Overflow): void {
    this.style.overflow = o
    this.markDirty()
  }
  /** 设置并保存 set Direction 对应的数据或状态。 */
  setDirection(d: Direction): void {
    this.style.direction = d
    this.markDirty()
  }
  /** 设置并保存 set Box Sizing 对应的数据或状态。 */
  setBoxSizing(_: BoxSizing): void {
    // 未实现 — Ink不使用content-box
  }

  // -- 样式设置器：间距

  setMargin(edge: Edge, v: number | 'auto' | string | undefined): void {
    const val = parseDimension(v)
    this.style.margin[edge] = val
    if (val.unit === Unit.Auto) this._hasAutoMargin = true
    else this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    this._hasMargin =
      this._hasAutoMargin || hasAnyDefinedEdge(this.style.margin)
    this.markDirty()
  }
  /** 设置并保存 set Margin Percent 对应的数据或状态。 */
  setMarginPercent(edge: Edge, v: number): void {
    this.style.margin[edge] = percentValue(v)
    this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    this._hasMargin = true
    this.markDirty()
  }
  /** 设置并保存 set Margin Auto 对应的数据或状态。 */
  setMarginAuto(edge: Edge): void {
    this.style.margin[edge] = AUTO_VALUE
    this._hasAutoMargin = true
    this._hasMargin = true
    this.markDirty()
  }
  /** 设置并保存 set Padding 对应的数据或状态。 */
  setPadding(edge: Edge, v: number | string | undefined): void {
    this.style.padding[edge] = parseDimension(v)
    this._hasPadding = hasAnyDefinedEdge(this.style.padding)
    this.markDirty()
  }
  /** 设置并保存 set Padding Percent 对应的数据或状态。 */
  setPaddingPercent(edge: Edge, v: number): void {
    this.style.padding[edge] = percentValue(v)
    this._hasPadding = true
    this.markDirty()
  }
  /** 设置并保存 set Border 对应的数据或状态。 */
  setBorder(edge: Edge, v: number | undefined): void {
    this.style.border[edge] = v === undefined ? UNDEFINED_VALUE : pointValue(v)
    this._hasBorder = hasAnyDefinedEdge(this.style.border)
    this.markDirty()
  }
  /** 设置并保存 set Gap 对应的数据或状态。 */
  setGap(gutter: Gutter, v: number | string | undefined): void {
    this.style.gap[gutter] = parseDimension(v)
    this.markDirty()
  }
  /** 设置并保存 set Gap Percent 对应的数据或状态。 */
  setGapPercent(gutter: Gutter, v: number): void {
    this.style.gap[gutter] = percentValue(v)
    this.markDirty()
  }

  // -- 样式获取器（部分——仅测试所需）

  getFlexDirection(): FlexDirection {
    return this.style.flexDirection
  }
  /** 获取 get Justify Content 对应的数据或状态。 */
  getJustifyContent(): Justify {
    return this.style.justifyContent
  }
  /** 获取 get Align Items 对应的数据或状态。 */
  getAlignItems(): Align {
    return this.style.alignItems
  }
  /** 获取 get Align Self 对应的数据或状态。 */
  getAlignSelf(): Align {
    return this.style.alignSelf
  }
  /** 获取 get Align Content 对应的数据或状态。 */
  getAlignContent(): Align {
    return this.style.alignContent
  }
  /** 获取 get Flex Grow 对应的数据或状态。 */
  getFlexGrow(): number {
    return this.style.flexGrow
  }
  /** 获取 get Flex Shrink 对应的数据或状态。 */
  getFlexShrink(): number {
    return this.style.flexShrink
  }
  /** 获取 get Flex Basis 对应的数据或状态。 */
  getFlexBasis(): Value {
    return this.style.flexBasis
  }
  /** 获取 get Flex Wrap 对应的数据或状态。 */
  getFlexWrap(): Wrap {
    return this.style.flexWrap
  }
  /** 获取 get Width 对应的数据或状态。 */
  getWidth(): Value {
    return this.style.width
  }
  /** 获取 get Height 对应的数据或状态。 */
  getHeight(): Value {
    return this.style.height
  }
  /** 获取 get Overflow 对应的数据或状态。 */
  getOverflow(): Overflow {
    return this.style.overflow
  }
  /** 获取 get Position Type 对应的数据或状态。 */
  getPositionType(): PositionType {
    return this.style.positionType
  }
  /** 获取 get Direction 对应的数据或状态。 */
  getDirection(): Direction {
    return this.style.direction
  }

  // -- 未使用的 API 存根（为 API 对等性而存在）

  copyStyle(_: Node): void {}
  /** 设置并保存 set Dirtied Func 对应的数据或状态。 */
  setDirtiedFunc(_: unknown): void {}
  /** 执行 unset Dirtied Func 对应的业务处理。 */
  unsetDirtiedFunc(): void {}
  /** 设置并保存 set Is Reference Baseline 对应的数据或状态。 */
  setIsReferenceBaseline(v: boolean): void {
    this.isReferenceBaseline_ = v
    this.markDirty()
  }
  /** 判断是否满足 is Reference Baseline 对应的数据或状态。 */
  isReferenceBaseline(): boolean {
    return this.isReferenceBaseline_
  }
  /** 设置并保存 set Aspect Ratio 对应的数据或状态。 */
  setAspectRatio(_: number | undefined): void {}
  /** 获取 get Aspect Ratio 对应的数据或状态。 */
  getAspectRatio(): number {
    return NaN
  }
  /** 设置并保存 set Always Forms Containing Block 对应的数据或状态。 */
  setAlwaysFormsContainingBlock(_: boolean): void {}

  // -- 布局入口点

  calculateLayout(
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    _direction?: Direction,
  ): void {
    _yogaNodesVisited = 0
    _yogaMeasureCalls = 0
    _yogaCacheHits = 0
    _generation++
    const w = ownerWidth === undefined ? NaN : ownerWidth
    const h = ownerHeight === undefined ? NaN : ownerHeight
    layoutNode(
      this,
      w,
      h,
      isDefined(w) ? MeasureMode.Exactly : MeasureMode.Undefined,
      isDefined(h) ? MeasureMode.Exactly : MeasureMode.Undefined,
      w,
      h,
      true,
    )
    // 根节点自身位置 = margin + position 偏移（yoga 即使没有父容器也会对根节点应用 position；这对舍入很重要，因为根节点的绝对顶部/左侧决定了像素网格遍历的起始点）。
    const mar = this.layout.margin
    const posL = resolveValue(
      resolveEdgeRaw(this.style.position, EDGE_LEFT),
      isDefined(w) ? w : 0,
    )
    const posT = resolveValue(
      resolveEdgeRaw(this.style.position, EDGE_TOP),
      isDefined(w) ? w : 0,
    )
    this.layout.left = mar[EDGE_LEFT] + (isDefined(posL) ? posL : 0)
    this.layout.top = mar[EDGE_TOP] + (isDefined(posT) ? posT : 0)
    roundLayout(this, this.config.pointScaleFactor, 0, 0)
  }
}

const DEFAULT_CONFIG = createConfig()

const CACHE_SLOTS = 4
/** 执行 cache Write 对应的业务处理。 */
function cacheWrite(
  node: Node,
  aW: number,
  aH: number,
  wM: MeasureMode,
  hM: MeasureMode,
  oW: number,
  oH: number,
  fW: boolean,
  fH: boolean,
  wasDirty: boolean,
): void {
  if (!node._cIn) {
    node._cIn = new Float64Array(CACHE_SLOTS * 8)
    node._cOut = new Float64Array(CACHE_SLOTS * 2)
  }
  // 脏标记后的首次写入会清除脏标记前的过时条目。
  // _cGen < _generation 表示条目来自之前的 calculateLayout；
  // 如果 wasDirty，子树自那时起已更改 → 旧尺寸无效。
  // 干净节点的旧条目保留——相同的子树 → 相同输入产生相同结果，
  // 因此跨代缓存可以工作（滚动热路径中，499 个干净消息命中缓存，而一个脏叶子重新计算）。
  if (wasDirty && node._cGen !== _generation) {
    node._cN = 0
    node._cWr = 0
  }
  // LRU 写入索引回绕；_cN 保持在 CACHE_SLOTS，因此读取扫描始终检查所有已填充的槽（而不仅仅是上次回绕后的那些）。
  const i = node._cWr++ % CACHE_SLOTS
  if (node._cN < CACHE_SLOTS) node._cN = node._cWr
  const o = i * 8
  const cIn = node._cIn
  cIn[o] = aW
  cIn[o + 1] = aH
  cIn[o + 2] = wM
  cIn[o + 3] = hM
  cIn[o + 4] = oW
  cIn[o + 5] = oH
  cIn[o + 6] = fW ? 1 : 0
  cIn[o + 7] = fH ? 1 : 0
  node._cOut![i * 2] = node.layout.width
  node._cOut![i * 2 + 1] = node.layout.height
  node._cGen = _generation
}

// 将计算得到的 layout.width/height 存储到单槽缓存输出字段中。
// _hasL/_hasM 输入在 layoutNode 顶部（计算前）提交；
// 输出必须在此处（计算后）提交，以便缓存命中可以恢复正确的尺寸。
// 如果没有这个，_hasL 命中将返回上次调用留下的任意 layout.width/height —— 可能是 heightMode=Undefined 度量传递中的内在内容高度，而不是布局传递中的受约束视口高度。
// 这就是滚动框 vpH=33→2624 的 bug：scrollTop 钳位到 0，视口变为空白。
function commitCacheOutputs(node: Node, performLayout: boolean): void {
  if (performLayout) {
    node._lOutW = node.layout.width
    node._lOutH = node.layout.height
  } else {
    node._mOutW = node.layout.width
    node._mOutH = node.layout.height
  }
}

// --
// 核心 flexbox 算法

// 性能分析计数器 —— 每次 calculateLayout 重置，通过 getYogaCounters 读取。
// 每次 calculateLayout() 时递增。节点在写入缓存时标记 _fbGen/_cGen；
// gen === _generation 的缓存条目是在此次传递中计算出来的，无论 isDirty_ 状态如何都是新的。
let _generation = 0
let _yogaNodesVisited = 0
let _yogaMeasureCalls = 0
let _yogaCacheHits = 0
let _yogaLiveNodes = 0
/** 获取 get Yoga Counters 对应的数据或状态。 */
export function getYogaCounters(): {
  visited: number
  measured: number
  cacheHits: number
  live: number
} {
  return {
    visited: _yogaNodesVisited,
    measured: _yogaMeasureCalls,
    cacheHits: _yogaCacheHits,
    live: _yogaLiveNodes,
  }
}

/** 执行 layout Node 对应的业务处理。 */
function layoutNode(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  widthMode: MeasureMode,
  heightMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
  performLayout: boolean,
  // 若为 true，则忽略此轴上的样式尺寸 —— flex 容器已确定主轴尺寸（flex-basis + grow/shrink 结果）。
  forceWidth = false,
  forceHeight = false,
): void {
  _yogaNodesVisited++
  const style = node.style
  const layout = node.layout

  // 脏标记跳过：干净的子树 + 匹配的输入 → 布局对象已包含答案。
  // 缓存的布局结果也满足度量请求（位置是尺寸的超集）；反之则不成立。
  // 同代条目无论 isDirty_ 如何都是新的 —— 它们是在本次 calculateLayout 中计算的，子树自那时起未更改。
  // 前代条目需要 !isDirty_（脏节点的脏标记前的缓存已过时）。
  // sameGen 仅限于 MEASURE 调用 —— 布局传递的缓存命中会跳过子节点定位递归（步骤 5），使子节点停留在过时位置。度量调用只需要 w/h，而缓存存储了这些。
  const sameGen = node._cGen === _generation && !performLayout
  if (!node.isDirty_ || sameGen) {
    if (
      !node.isDirty_ &&
      node._hasL &&
      node._lWM === widthMode &&
      node._lHM === heightMode &&
      node._lFW === forceWidth &&
      node._lFH === forceHeight &&
      sameFloat(node._lW, availableWidth) &&
      sameFloat(node._lH, availableHeight) &&
      sameFloat(node._lOW, ownerWidth) &&
      sameFloat(node._lOH, ownerHeight)
    ) {
      _yogaCacheHits++
      layout.width = node._lOutW
      layout.height = node._lOutH
      return
    }
    // 多条目缓存：扫描匹配输入，命中时恢复缓存的 w/h。
    // 覆盖滚动场景：脏祖先的 measure→layout 级联为每个干净子节点产生 N>1 个不同的输入组合 —— 单个 _hasL 槽抖动，强制完整子树递归。对于含 500 条消息的滚动框和一个脏叶子，这使脏叶子重新布局从 76k 次 layoutNode 调用（21.7×节点数）降至 4k 次（1.2×节点数），6.86ms → 550µs。
    // 同代检查覆盖虚拟滚动期间新挂载（脏）节点 —— 脏链以 ≥2^深度 次调用它们，首次调用写入缓存，其余命中：1593 节点树从 105k 次访问降至约 10k 次。
    if (node._cN > 0 && (sameGen || !node.isDirty_)) {
      const cIn = node._cIn!
      for (let i = 0; i < node._cN; i++) {
        const o = i * 8
        if (
          cIn[o + 2] === widthMode &&
          cIn[o + 3] === heightMode &&
          cIn[o + 6] === (forceWidth ? 1 : 0) &&
          cIn[o + 7] === (forceHeight ? 1 : 0) &&
          sameFloat(cIn[o]!, availableWidth) &&
          sameFloat(cIn[o + 1]!, availableHeight) &&
          sameFloat(cIn[o + 4]!, ownerWidth) &&
          sameFloat(cIn[o + 5]!, ownerHeight)
        ) {
          layout.width = node._cOut![i * 2]!
          layout.height = node._cOut![i * 2 + 1]!
          _yogaCacheHits++
          return
        }
      }
    }
    if (
      !node.isDirty_ &&
      !performLayout &&
      node._hasM &&
      node._mWM === widthMode &&
      node._mHM === heightMode &&
      sameFloat(node._mW, availableWidth) &&
      sameFloat(node._mH, availableHeight) &&
      sameFloat(node._mOW, ownerWidth) &&
      sameFloat(node._mOH, ownerHeight)
    ) {
      layout.width = node._mOutW
      layout.height = node._mOutH
      _yogaCacheHits++
      return
    }
  }
  // 预先提交缓存输入，使每个返回路径都留下有效条目。
  // 仅在 LAYOUT 传递中清除 isDirty_ —— 度量传递（computeFlexBasis → layoutNode(performLayout=false)）在同一个 calculateLayout 调用中的布局传递之前运行。在度量期间清除脏标记会使后续布局传递命中前一个 calculateLayout 的过时 _hasL 缓存（在子节点插入之前），因此 ScrollBox 内容高度永远不会增长，粘性滚动永远不会跟随新内容。脏节点的 _hasL 条目本质上已过时 —— 使其失效，以便布局传递重新计算。
  const wasDirty = node.isDirty_
  if (performLayout) {
    node._lW = availableWidth
    node._lH = availableHeight
    node._lWM = widthMode
    node._lHM = heightMode
    node._lOW = ownerWidth
    node._lOH = ownerHeight
    node._lFW = forceWidth
    node._lFH = forceHeight
    node._hasL = true
    node.isDirty_ = false
    // 以前的方法在此处清除 _cN 以防止脏前的过时条目命中（长期连续空白屏幕 bug）。现在被代戳记取代：缓存检查要求 sameGen || !isDirty_，因此脏节点的前代条目无法命中。在此处清除会抹掉来自先前度量调用的新鲜同代条目，强制在布局调用时重新计算。
    if (wasDirty) node._hasM = false
  } else {
    node._mW = availableWidth
    node._mH = availableHeight
    node._mWM = widthMode
    node._mHM = heightMode
    node._mOW = ownerWidth
    node._mOH = ownerHeight
    node._hasM = true
    // 不清除 isDirty_。对于 DIRTY 节点，使 _hasL 失效，以便接下来的 performLayout=true 调用使用新的子节点集重新计算（否则粘性滚动永远不会跟随新内容 —— 来自 4557bc9f9c 的 bug）。
    // 干净节点保留 _hasL：它们前一代的布局仍然有效，它们只是因为祖先脏且以不同输入调用而在此处。
    if (wasDirty) node._hasL = false
  }

  // 根据 ownerWidth 解析 padding/border/margin（yoga 对 % 使用 ownerWidth）
  // 直接写入预分配的布局数组 —— 避免每次 layoutNode 调用 3 次分配和 12 次 resolveEdge 调用（曾是 CPU 分析中的头号热点）。
  // 当未设置任何边时完全跳过 —— 4 次写入零比 resolveEdges4Into 产生零所需的约 20 次读取 + 约 15 次比较更便宜。
  const pad = layout.padding
  const bor = layout.border
  const mar = layout.margin
  if (node._hasPadding) resolveEdges4Into(style.padding, ownerWidth, pad)
  else pad[0] = pad[1] = pad[2] = pad[3] = 0
  if (node._hasBorder) resolveEdges4Into(style.border, ownerWidth, bor)
  else bor[0] = bor[1] = bor[2] = bor[3] = 0
  if (node._hasMargin) resolveEdges4Into(style.margin, ownerWidth, mar)
  else mar[0] = mar[1] = mar[2] = mar[3] = 0

  const paddingBorderWidth = pad[0] + pad[2] + bor[0] + bor[2]
  const paddingBorderHeight = pad[1] + pad[3] + bor[1] + bor[3]

  // 解析样式尺寸
  const styleWidth = forceWidth ? NaN : resolveValue(style.width, ownerWidth)
  const styleHeight = forceHeight
    ? NaN
    : resolveValue(style.height, ownerHeight)

  // 如果样式尺寸已定义，则覆盖可用大小
  let width = availableWidth
  let height = availableHeight
  let wMode = widthMode
  let hMode = heightMode
  if (isDefined(styleWidth)) {
    width = styleWidth
    wMode = MeasureMode.Exactly
  }
  if (isDefined(styleHeight)) {
    height = styleHeight
    hMode = MeasureMode.Exactly
  }

  // 将最小/最大约束应用于节点自身的尺寸
  width = boundAxis(style, true, width, ownerWidth, ownerHeight)
  height = boundAxis(style, false, height, ownerWidth, ownerHeight)

  // 度量函数叶子节点
  if (node.measureFunc && node.children.length === 0) {
    const innerW =
      wMode === MeasureMode.Undefined
        ? NaN
        : Math.max(0, width - paddingBorderWidth)
    const innerH =
      hMode === MeasureMode.Undefined
        ? NaN
        : Math.max(0, height - paddingBorderHeight)
    _yogaMeasureCalls++
    const measured = node.measureFunc(innerW, wMode, innerH, hMode)
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(
            style,
            true,
            (measured.width ?? 0) + paddingBorderWidth,
            ownerWidth,
            ownerHeight,
          )
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(
            style,
            false,
            (measured.height ?? 0) + paddingBorderHeight,
            ownerWidth,
            ownerHeight,
          )
    commitCacheOutputs(node, performLayout)
    // 即使对脏节点也写入缓存 —— 虚拟滚动期间新挂载的项在首次布局时是脏的，但脏链的 measure→layout 级联在每个 calculateLayout 中以 ≥2^深度 次调用它们。在此写入使得第 2 次及后续调用可以命中缓存（isDirty_ 在上面的布局传递中已被清除）。实测：1593 节点新挂载树从 105k 次访问降至 10k 次。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 没有子节点且没有度量函数的叶子节点
  if (node.children.length === 0) {
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(style, true, paddingBorderWidth, ownerWidth, ownerHeight)
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(style, false, paddingBorderHeight, ownerWidth, ownerHeight)
    commitCacheOutputs(node, performLayout)
    // 即使对脏节点也写入缓存——虚拟滚动期间新挂载的项在首次布局时是脏的，但脏链的measure→layout级联在每次calculateLayout中会调用它们≥2^depth次。在此处写入缓存让第2+次调用命中缓存（上面的布局遍历中isDirty_已被清除）。测量结果：一个1593节点新挂载树的105k次访问变为10k次。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 带子节点的容器——运行flexbox算法
  const mainAxis = style.flexDirection
  const crossAx = crossAxis(mainAxis)
  const isMainRow = isRow(mainAxis)

  const mainSize = isMainRow ? width : height
  const crossSize = isMainRow ? height : width
  const mainMode = isMainRow ? wMode : hMode
  const crossMode = isMainRow ? hMode : wMode
  const mainPadBorder = isMainRow ? paddingBorderWidth : paddingBorderHeight
  const crossPadBorder = isMainRow ? paddingBorderHeight : paddingBorderWidth

  const innerMainSize = isDefined(mainSize)
    ? Math.max(0, mainSize - mainPadBorder)
    : NaN
  const innerCrossSize = isDefined(crossSize)
    ? Math.max(0, crossSize - crossPadBorder)
    : NaN

  // 解析gap
  const gapMain = resolveGap(
    style,
    isMainRow ? Gutter.Column : Gutter.Row,
    innerMainSize,
  )

  // 将子节点划分为流式 vs 绝对。display:contents节点是透明的——它们的子节点被提升到祖父级的子节点列表中（递归），而contents节点本身获得零布局。
  const flowChildren: Node[] = []
  const absChildren: Node[] = []
  collectLayoutChildren(node, flowChildren, absChildren)

  // ownerW/H 是解析子节点百分比值的参考尺寸。根据CSS，百分比宽度相对于父元素的内容盒宽度解析。如果此节点的宽度是不定的，子节点的百分比宽度也是不定的——不要回退到祖父级的尺寸。
  const ownerW = isDefined(width) ? width : NaN
  const ownerH = isDefined(height) ? height : NaN
  const isWrap = style.flexWrap !== Wrap.NoWrap
  const gapCross = resolveGap(
    style,
    isMainRow ? Gutter.Row : Gutter.Column,
    innerCrossSize,
  )

  // 步骤1：计算每个流式子节点的flex-basis并断行。单行（NoWrap）容器总是只有一行；多行容器在累计的basis+margin+gap超过innerMainSize时断行。
  for (const c of flowChildren) {
    c._flexBasis = computeFlexBasis(
      c,
      mainAxis,
      innerMainSize,
      innerCrossSize,
      crossMode,
      ownerW,
      ownerH,
    )
  }
  const lines: Node[][] = []
  if (!isWrap || !isDefined(innerMainSize) || flowChildren.length === 0) {
    for (const c of flowChildren) c._lineIndex = 0
    lines.push(flowChildren)
  } else {
    // 断行决策使用min/max钳制后的basis（flexbox规范§9.3.5：“假设的主尺寸”），而不是原始flex-basis。
    let lineStart = 0
    let lineLen = 0
    for (let i = 0; i < flowChildren.length; i++) {
      const c = flowChildren[i]!
      const hypo = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
      const outer = Math.max(0, hypo) + childMarginForAxis(c, mainAxis, ownerW)
      const withGap = i > lineStart ? gapMain : 0
      if (i > lineStart && lineLen + withGap + outer > innerMainSize) {
        lines.push(flowChildren.slice(lineStart, i))
        lineStart = i
        lineLen = outer
      } else {
        lineLen += withGap + outer
      }
      c._lineIndex = lines.length
    }
    lines.push(flowChildren.slice(lineStart))
  }
  const lineCount = lines.length
  const isBaseline = isBaselineLayout(node, flowChildren)

  // 步骤2+3：对每一行，解析弹性长度并将子节点布局以测量交叉尺寸。跟踪每行消耗的主尺寸和最大交叉尺寸。
  const lineConsumedMain: number[] = new Array(lineCount)
  const lineCrossSizes: number[] = new Array(lineCount)
  // 基线布局跟踪每行的最大上升高度（基线+前导边距），以便基线对齐的项可以定位在 maxAscent - childBaseline。
  const lineMaxAscent: number[] = isBaseline ? new Array(lineCount).fill(0) : []
  let maxLineMain = 0
  let totalLinesCross = 0
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineGap = line.length > 1 ? gapMain * (line.length - 1) : 0
    let lineBasis = lineGap
    for (const c of line) {
      lineBasis += c._flexBasis + childMarginForAxis(c, mainAxis, ownerW)
    }
    // 根据可用的内部主轴解析弹性长度。对于设置了min/max的不定容器，弹性布局针对钳制后的尺寸。
    let availMain = innerMainSize
    if (!isDefined(availMain)) {
      const mainOwner = isMainRow ? ownerWidth : ownerHeight
      const minM = resolveValue(
        isMainRow ? style.minWidth : style.minHeight,
        mainOwner,
      )
      const maxM = resolveValue(
        isMainRow ? style.maxWidth : style.maxHeight,
        mainOwner,
      )
      if (isDefined(maxM) && lineBasis > maxM - mainPadBorder) {
        availMain = Math.max(0, maxM - mainPadBorder)
      } else if (isDefined(minM) && lineBasis < minM - mainPadBorder) {
        availMain = Math.max(0, minM - mainPadBorder)
      }
    }
    resolveFlexibleLengths(
      line,
      availMain,
      lineBasis,
      isMainRow,
      ownerW,
      ownerH,
    )

    // 布局该行中的每个子节点以测量交叉尺寸
    let lineCross = 0
    for (const c of line) {
      const cStyle = c.style
      const childAlign =
        cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
      const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
      let childCrossSize = NaN
      let childCrossMode: MeasureMode = MeasureMode.Undefined
      const resolvedCrossStyle = resolveValue(
        isMainRow ? cStyle.height : cStyle.width,
        isMainRow ? ownerH : ownerW,
      )
      const crossLeadE = isMainRow ? EDGE_TOP : EDGE_LEFT
      const crossTrailE = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
      const hasCrossAutoMargin =
        c._hasAutoMargin &&
        (isMarginAuto(cStyle.margin, crossLeadE) ||
          isMarginAuto(cStyle.margin, crossTrailE))
      // 单行拉伸直接使用容器的交叉尺寸。多行换行测量内在交叉尺寸（Undefined模式），因此flex-grow的孙节点不会扩展到容器——先确定行交叉尺寸，然后再重新拉伸项。
      if (isDefined(resolvedCrossStyle)) {
        childCrossSize = resolvedCrossStyle
        childCrossMode = MeasureMode.Exactly
      } else if (
        childAlign === Align.Stretch &&
        !hasCrossAutoMargin &&
        !isWrap &&
        isDefined(innerCrossSize) &&
        crossMode === MeasureMode.Exactly
      ) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.Exactly
      } else if (!isWrap && isDefined(innerCrossSize)) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.AtMost
      }
      const cw = isMainRow ? c._mainSize : childCrossSize
      const ch = isMainRow ? childCrossSize : c._mainSize
      layoutNode(
        c,
        cw,
        ch,
        isMainRow ? MeasureMode.Exactly : childCrossMode,
        isMainRow ? childCrossMode : MeasureMode.Exactly,
        ownerW,
        ownerH,
        performLayout,
        isMainRow,
        !isMainRow,
      )
      c._crossSize = isMainRow ? c.layout.height : c.layout.width
      lineCross = Math.max(lineCross, c._crossSize + cMarginCross)
    }
    // 基线布局：行交叉尺寸必须容纳基线对齐子节点的maxAscent + maxDescent（yoga步骤8）。仅适用于行方向。
    if (isBaseline) {
      let maxAscent = 0
      let maxDescent = 0
      for (const c of line) {
        if (resolveChildAlign(node, c) !== Align.Baseline) continue
        const mTop = resolveEdge(c.style.margin, EDGE_TOP, ownerW)
        const mBot = resolveEdge(c.style.margin, EDGE_BOTTOM, ownerW)
        const ascent = calculateBaseline(c) + mTop
        const descent = c.layout.height + mTop + mBot - ascent
        if (ascent > maxAscent) maxAscent = ascent
        if (descent > maxDescent) maxDescent = descent
      }
      lineMaxAscent[li] = maxAscent
      if (maxAscent + maxDescent > lineCross) {
        lineCross = maxAscent + maxDescent
      }
    }
    // 上面约第1117行的 layoutNode(c) 已通过 resolveEdges4Into 使用相同的 ownerW 解析了 c.layout.margin[] —— 直接读取，而不是通过 childMarginForAxis → 2× resolveEdge 重新解析。
    const mainLead = leadingEdge(mainAxis)
    const mainTrail = trailingEdge(mainAxis)
    let consumed = lineGap
    for (const c of line) {
      const cm = c.layout.margin
      consumed += c._mainSize + cm[mainLead]! + cm[mainTrail]!
    }
    lineConsumedMain[li] = consumed
    lineCrossSizes[li] = lineCross
    maxLineMain = Math.max(maxLineMain, consumed)
    totalLinesCross += lineCross
  }
  const totalCrossGap = lineCount > 1 ? gapCross * (lineCount - 1) : 0
  totalLinesCross += totalCrossGap

  // 步骤4：确定容器尺寸。根据yoga步骤9，对于 AtMost (FitContent) 和 Undefined (MaxContent)，节点尺寸适应其内容——AtMost 不是硬钳制，项可能溢出可用空间（CSS “fit-content” 行为）。只有 Scroll 溢出会钳制到可用尺寸。在 AtMost 下断成多行的换行容器会填充可用的主轴尺寸，因为它们在该边界处换行。
  const isScroll = style.overflow === Overflow.Scroll
  const contentMain = maxLineMain + mainPadBorder
  const finalMainSize =
    mainMode === MeasureMode.Exactly
      ? mainSize
      : mainMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(mainSize, contentMain), mainPadBorder)
        : isWrap && lineCount > 1 && mainMode === MeasureMode.AtMost
          ? mainSize
          : contentMain
  const contentCross = totalLinesCross + crossPadBorder
  const finalCrossSize =
    crossMode === MeasureMode.Exactly
      ? crossSize
      : crossMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(crossSize, contentCross), crossPadBorder)
        : contentCross
  node.layout.width = boundAxis(
    style,
    true,
    isMainRow ? finalMainSize : finalCrossSize,
    ownerWidth,
    ownerHeight,
  )
  node.layout.height = boundAxis(
    style,
    false,
    isMainRow ? finalCrossSize : finalMainSize,
    ownerWidth,
    ownerHeight,
  )
  commitCacheOutputs(node, performLayout)
  // 即使对脏节点也写入缓存——虚拟滚动期间新挂载的项
  cacheWrite(
    node,
    availableWidth,
    availableHeight,
    widthMode,
    heightMode,
    ownerWidth,
    ownerHeight,
    forceWidth,
    forceHeight,
    wasDirty,
  )

  if (!performLayout) return

  // 步骤5：定位行（align-content）和子节点（justify-content + align-items + auto margins）。
  const actualInnerMain =
    (isMainRow ? node.layout.width : node.layout.height) - mainPadBorder
  const actualInnerCross =
    (isMainRow ? node.layout.height : node.layout.width) - crossPadBorder
  const mainLeadEdgePhys = leadingEdge(mainAxis)
  const mainTrailEdgePhys = trailingEdge(mainAxis)
  const crossLeadEdgePhys = isMainRow ? EDGE_TOP : EDGE_LEFT
  const crossTrailEdgePhys = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
  const reversed = isReverse(mainAxis)
  const mainContainerSize = isMainRow ? node.layout.width : node.layout.height
  const crossLead = pad[crossLeadEdgePhys]! + bor[crossLeadEdgePhys]!

  // Align-content：在行之间分布空闲交叉空间。单行容器使用完整的交叉尺寸给该单行（align-items 处理其中的定位）。
  let lineCrossOffset = crossLead
  let betweenLines = gapCross
  const freeCross = actualInnerCross - totalLinesCross
  if (lineCount === 1 && !isWrap && !isBaseline) {
    lineCrossSizes[0] = actualInnerCross
  } else {
    const remCross = Math.max(0, freeCross)
    switch (style.alignContent) {
      case Align.FlexStart:
        break
      case Align.Center:
        lineCrossOffset += freeCross / 2
        break
      case Align.FlexEnd:
        lineCrossOffset += freeCross
        break
      case Align.Stretch:
        if (lineCount > 0 && remCross > 0) {
          const add = remCross / lineCount
          for (let i = 0; i < lineCount; i++) lineCrossSizes[i]! += add
        }
        break
      case Align.SpaceBetween:
        if (lineCount > 1) betweenLines += remCross / (lineCount - 1)
        break
      case Align.SpaceAround:
        if (lineCount > 0) {
          betweenLines += remCross / lineCount
          lineCrossOffset += remCross / lineCount / 2
        }
        break
      case Align.SpaceEvenly:
        if (lineCount > 0) {
          betweenLines += remCross / (lineCount + 1)
          lineCrossOffset += remCross / (lineCount + 1)
        }
        break
      default:
        break
    }
  }

  // 对于 wrap-reverse，行从尾部交叉边缘开始堆叠。按顺序遍历行，但翻转容器内的交叉位置。
  const wrapReverse = style.flexWrap === Wrap.WrapReverse
  const crossContainerSize = isMainRow ? node.layout.height : node.layout.width
  let lineCrossPos = lineCrossOffset
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineCross = lineCrossSizes[li]!
    const consumedMain = lineConsumedMain[li]!
    const n = line.length

    // 重新拉伸那些交叉尺寸为auto且对齐方式为stretch的子节点（现在行交叉尺寸已知）。多行换行时需要（初始测量时行交叉尺寸未知），单行时也需要（当容器交叉尺寸不是 Exactly 时，初始拉伸在约第1250行被跳过，因为 innerCrossSize 未定义——容器尺寸适应子节点最大交叉尺寸）。
    if (isWrap || crossMode !== MeasureMode.Exactly) {
      for (const c of line) {
        const cStyle = c.style
        const childAlign =
          cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
        const crossStyleDef = isDefined(
          resolveValue(
            isMainRow ? cStyle.height : cStyle.width,
            isMainRow ? ownerH : ownerW,
          ),
        )
        const hasCrossAutoMargin =
          c._hasAutoMargin &&
          (isMarginAuto(cStyle.margin, crossLeadEdgePhys) ||
            isMarginAuto(cStyle.margin, crossTrailEdgePhys))
        if (
          childAlign === Align.Stretch &&
          !crossStyleDef &&
          !hasCrossAutoMargin
        ) {
          const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
          const target = Math.max(0, lineCross - cMarginCross)
          if (c._crossSize !== target) {
            const cw = isMainRow ? c._mainSize : target
            const ch = isMainRow ? target : c._mainSize
            layoutNode(
              c,
              cw,
              ch,
              MeasureMode.Exactly,
              MeasureMode.Exactly,
              ownerW,
              ownerH,
              performLayout,
              isMainRow,
              !isMainRow,
            )
            c._crossSize = target
          }
        }
      }
    }

    // 该行的 justify-content + auto margins
    let mainOffset = pad[mainLeadEdgePhys]! + bor[mainLeadEdgePhys]!
    let betweenMain = gapMain
    let numAutoMarginsMain = 0
    for (const c of line) {
      if (!c._hasAutoMargin) continue
      if (isMarginAuto(c.style.margin, mainLeadEdgePhys)) numAutoMarginsMain++
      if (isMarginAuto(c.style.margin, mainTrailEdgePhys)) numAutoMarginsMain++
    }
    const freeMain = actualInnerMain - consumedMain
    const remainingMain = Math.max(0, freeMain)
    const autoMarginMainSize =
      numAutoMarginsMain > 0 && remainingMain > 0
        ? remainingMain / numAutoMarginsMain
        : 0
    if (numAutoMarginsMain === 0) {
      switch (style.justifyContent) {
        case Justify.FlexStart:
          break
        case Justify.Center:
          mainOffset += freeMain / 2
          break
        case Justify.FlexEnd:
          mainOffset += freeMain
          break
        case Justify.SpaceBetween:
          if (n > 1) betweenMain += remainingMain / (n - 1)
          break
        case Justify.SpaceAround:
          if (n > 0) {
            betweenMain += remainingMain / n
            mainOffset += remainingMain / n / 2
          }
          break
        case Justify.SpaceEvenly:
          if (n > 0) {
            betweenMain += remainingMain / (n + 1)
            mainOffset += remainingMain / (n + 1)
          }
          break
      }
    }

    const effectiveLineCrossPos = wrapReverse
      ? crossContainerSize - lineCrossPos - lineCross
      : lineCrossPos

    let pos = mainOffset
    for (const c of line) {
      const cMargin = c.style.margin
      // c.layout.margin[] 由上方 layoutNode(c) 调用内部的 resolveEdges4Into 填充（相同 ownerW）。直接读取解析后的值，而不是通过 resolveEdge 重新运行边缘回退链 4 次。Auto margins 在 layout.margin 中解析为 0，因此 autoMarginMainSize 替换仍然使用对样式的 isMarginAuto 检查。
      const cLayoutMargin = c.layout.margin
      let autoMainLead = false
      let autoMainTrail = false
      let autoCrossLead = false
      let autoCrossTrail = false
      let mMainLead: number
      let mMainTrail: number
      let mCrossLead: number
      let mCrossTrail: number
      if (c._hasAutoMargin) {
        autoMainLead = isMarginAuto(cMargin, mainLeadEdgePhys)
        autoMainTrail = isMarginAuto(cMargin, mainTrailEdgePhys)
        autoCrossLead = isMarginAuto(cMargin, crossLeadEdgePhys)
        autoCrossTrail = isMarginAuto(cMargin, crossTrailEdgePhys)
        mMainLead = autoMainLead
          ? autoMarginMainSize
          : cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = autoMainTrail
          ? autoMarginMainSize
          : cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = autoCrossLead ? 0 : cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = autoCrossTrail ? 0 : cLayoutMargin[crossTrailEdgePhys]!
      } else {
        // 快速路径：无 auto margins —— 直接读取解析后的值。
        mMainLead = cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = cLayoutMargin[crossTrailEdgePhys]!
      }

      const mainPos = reversed
        ? mainContainerSize - (pos + mMainLead) - c._mainSize
        : pos + mMainLead

      const childAlign =
        c.style.alignSelf === Align.Auto ? style.alignItems : c.style.alignSelf
      let crossPos = effectiveLineCrossPos + mCrossLead
      const crossFree = lineCross - c._crossSize - mCrossLead - mCrossTrail
      if (autoCrossLead && autoCrossTrail) {
        crossPos += Math.max(0, crossFree) / 2
      } else if (autoCrossLead) {
        crossPos += Math.max(0, crossFree)
      } else if (autoCrossTrail) {
        // 保持在 leading 位置
      } else {
        switch (childAlign) {
          case Align.FlexStart:
          case Align.Stretch:
            if (wrapReverse) crossPos += crossFree
            break
          case Align.Center:
            crossPos += crossFree / 2
            break
          case Align.FlexEnd:
            if (!wrapReverse) crossPos += crossFree
            break
          case Align.Baseline:
            // 仅行方向（已检查 isBaselineLayout）。定位使得子项的基线对齐行的最大上升高度。根据 yoga：top = currentLead + maxAscent - childBaseline + leadingPosition。
            if (isBaseline) {
              crossPos =
                effectiveLineCrossPos +
                lineMaxAscent[li]! -
                calculateBaseline(c)
            }
            break
          default:
            break
        }
      }

      // 相对位置偏移。快速路径：未设置位置内嵌 → 跳过 4× resolveEdgeRaw + 4× resolveValue + 4× isDefined。
      let relX = 0
      let relY = 0
      if (c._hasPosition) {
        const relLeft = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_LEFT),
          ownerW,
        )
        const relRight = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_RIGHT),
          ownerW,
        )
        const relTop = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_TOP),
          ownerW,
        )
        const relBottom = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_BOTTOM),
          ownerW,
        )
        relX = isDefined(relLeft)
          ? relLeft
          : isDefined(relRight)
            ? -relRight
            : 0
        relY = isDefined(relTop)
          ? relTop
          : isDefined(relBottom)
            ? -relBottom
            : 0
      }

      if (isMainRow) {
        c.layout.left = mainPos + relX
        c.layout.top = crossPos + relY
      } else {
        c.layout.left = crossPos + relX
        c.layout.top = mainPos + relY
      }
      pos += c._mainSize + mMainLead + mMainTrail + betweenMain
    }
    lineCrossPos += lineCross + betweenLines
  }

  // 步骤 6：绝对定位的子项
  for (const c of absChildren) {
    layoutAbsoluteChild(
      node,
      c,
      node.layout.width,
      node.layout.height,
      pad,
      bor,
    )
  }
}

/** 执行 layout Absolute Child 对应的业务处理。 */
function layoutAbsoluteChild(
  parent: Node,
  child: Node,
  parentWidth: number,
  parentHeight: number,
  pad: [number, number, number, number],
  bor: [number, number, number, number],
): void {
  const cs = child.style
  const posLeft = resolveEdgeRaw(cs.position, EDGE_LEFT)
  const posRight = resolveEdgeRaw(cs.position, EDGE_RIGHT)
  const posTop = resolveEdgeRaw(cs.position, EDGE_TOP)
  const posBottom = resolveEdgeRaw(cs.position, EDGE_BOTTOM)

  const rLeft = resolveValue(posLeft, parentWidth)
  const rRight = resolveValue(posRight, parentWidth)
  const rTop = resolveValue(posTop, parentHeight)
  const rBottom = resolveValue(posBottom, parentHeight)

  // 绝对定位子项的百分比尺寸根据包含块的 padding-box（父元素尺寸减去边框）解析，依据 CSS §10.1。
  const paddingBoxW = parentWidth - bor[0] - bor[2]
  const paddingBoxH = parentHeight - bor[1] - bor[3]
  let cw = resolveValue(cs.width, paddingBoxW)
  let ch = resolveValue(cs.height, paddingBoxH)

  // 如果同时定义了 left 和 right 而未定义 width，则推导 width
  if (!isDefined(cw) && isDefined(rLeft) && isDefined(rRight)) {
    cw = paddingBoxW - rLeft - rRight
  }
  if (!isDefined(ch) && isDefined(rTop) && isDefined(rBottom)) {
    ch = paddingBoxH - rTop - rBottom
  }

  layoutNode(
    child,
    cw,
    ch,
    isDefined(cw) ? MeasureMode.Exactly : MeasureMode.Undefined,
    isDefined(ch) ? MeasureMode.Exactly : MeasureMode.Undefined,
    paddingBoxW,
    paddingBoxH,
    true,
  )

  // 绝对定位子项的外边距（额外应用于内嵌之上）
  const mL = resolveEdge(cs.margin, EDGE_LEFT, parentWidth)
  const mT = resolveEdge(cs.margin, EDGE_TOP, parentWidth)
  const mR = resolveEdge(cs.margin, EDGE_RIGHT, parentWidth)
  const mB = resolveEdge(cs.margin, EDGE_BOTTOM, parentWidth)

  const mainAxis = parent.style.flexDirection
  const reversed = isReverse(mainAxis)
  const mainRow = isRow(mainAxis)
  const wrapReverse = parent.style.flexWrap === Wrap.WrapReverse
  // alignSelf 覆盖 alignItems 对绝对定位子项的效果（与流式项相同）
  const alignment =
    cs.alignSelf === Align.Auto ? parent.style.alignItems : cs.alignSelf

  // 位置
  let left: number
  if (isDefined(rLeft)) {
    left = bor[0] + rLeft + mL
  } else if (isDefined(rRight)) {
    left = parentWidth - bor[2] - rRight - child.layout.width - mR
  } else if (mainRow) {
    // 主轴 — justify-content，反向时翻转
    const lead = pad[0] + bor[0]
    const trail = parentWidth - pad[2] - bor[2]
    left = reversed
      ? trail - child.layout.width - mR
      : justifyAbsolute(
          parent.style.justifyContent,
          lead,
          trail,
          child.layout.width,
        ) + mL
  } else {
    left =
      alignAbsolute(
        alignment,
        pad[0] + bor[0],
        parentWidth - pad[2] - bor[2],
        child.layout.width,
        wrapReverse,
      ) + mL
  }

  let top: number
  if (isDefined(rTop)) {
    top = bor[1] + rTop + mT
  } else if (isDefined(rBottom)) {
    top = parentHeight - bor[3] - rBottom - child.layout.height - mB
  } else if (mainRow) {
    top =
      alignAbsolute(
        alignment,
        pad[1] + bor[1],
        parentHeight - pad[3] - bor[3],
        child.layout.height,
        wrapReverse,
      ) + mT
  } else {
    const lead = pad[1] + bor[1]
    const trail = parentHeight - pad[3] - bor[3]
    top = reversed
      ? trail - child.layout.height - mB
      : justifyAbsolute(
          parent.style.justifyContent,
          lead,
          trail,
          child.layout.height,
        ) + mT
  }

  child.layout.left = left
  child.layout.top = top
}

/** 执行 justify Absolute 对应的业务处理。 */
function justifyAbsolute(
  justify: Justify,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
): number {
  switch (justify) {
    case Justify.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Justify.FlexEnd:
      return trailEdge - childSize
    default:
      return leadEdge
  }
}

/** 执行 align Absolute 对应的业务处理。 */
function alignAbsolute(
  align: Align,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
  wrapReverse: boolean,
): number {
  // Wrap-reverse 翻转交叉轴：flex-start/stretch 变为尾部，flex-end 变为首部（当包含块设置 wrap-reverse 时，yoga 的 absoluteLayoutChild 翻转对齐值）。
  switch (align) {
    case Align.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Align.FlexEnd:
      return wrapReverse ? leadEdge : trailEdge - childSize
    default:
      return wrapReverse ? trailEdge - childSize : leadEdge
  }
}

/** 计算 compute Flex Basis 对应的数据或状态。 */
function computeFlexBasis(
  child: Node,
  mainAxis: FlexDirection,
  availableMain: number,
  availableCross: number,
  crossMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
): number {
  // 同代缓存命中：基准值在此次 calculateLayout 中计算，因此无论 isDirty_ 如何都是新鲜的。涵盖干净的子项（滚动经过未更改的消息）和新挂载的脏子项（虚拟滚动挂载新项 — 脏链的 measure→layout 级联会调用此方法 ≥2^深度 次，但在一次 calculateLayout 内子项的子树不会变化）。对于具有上一代缓存的干净子项，如果输入匹配也会命中 — isDirty_ 作为门控，因为脏子项的上代缓存已过时。
  const sameGen = child._fbGen === _generation
  if (
    (sameGen || !child.isDirty_) &&
    child._fbCrossMode === crossMode &&
    sameFloat(child._fbOwnerW, ownerWidth) &&
    sameFloat(child._fbOwnerH, ownerHeight) &&
    sameFloat(child._fbAvailMain, availableMain) &&
    sameFloat(child._fbAvailCross, availableCross)
  ) {
    return child._fbBasis
  }
  const cs = child.style
  const isMainRow = isRow(mainAxis)

  // 显式 flex-basis
  const basis = resolveValue(cs.flexBasis, availableMain)
  if (isDefined(basis)) {
    const b = Math.max(0, basis)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 主轴上的样式尺寸
  const mainStyleDim = isMainRow ? cs.width : cs.height
  const mainOwner = isMainRow ? ownerWidth : ownerHeight
  const resolved = resolveValue(mainStyleDim, mainOwner)
  if (isDefined(resolved)) {
    const b = Math.max(0, resolved)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 需要测量子项以获取其自然尺寸
  const crossStyleDim = isMainRow ? cs.height : cs.width
  const crossOwner = isMainRow ? ownerHeight : ownerWidth
  let crossConstraint = resolveValue(crossStyleDim, crossOwner)
  let crossConstraintMode: MeasureMode = isDefined(crossConstraint)
    ? MeasureMode.Exactly
    : MeasureMode.Undefined
  if (!isDefined(crossConstraint) && isDefined(availableCross)) {
    crossConstraint = availableCross
    crossConstraintMode =
      crossMode === MeasureMode.Exactly && isStretchAlign(child)
        ? MeasureMode.Exactly
        : MeasureMode.AtMost
  }

  // 上游 yoga（YGNodeComputeFlexBasisForChild）在子树将调用测量函数时，以 AtMost 模式传递可用内部宽度 — 这样文本节点不会将无约束的固有宽度报告为 flex-basis，否则会迫使兄弟节点收缩并在错误宽度处换行。在此处传递 Undefined 会导致 Ink 的 <Text> 在 <Box flexGrow={1}> 内部获取 width = 固有宽度而非可用宽度，导致换行边界丢弃字符。
  //
  // 此行为适用的两个约束：
  //   - 仅宽度。高度在基准测量期间从不约束 — 列容器必须以自然高度测量子项，以便可滚动内容溢出（约束高度会裁剪 ScrollBox）。
  //   - 子树具有测量函数。纯布局子树（无测量函数）中带有 flex-grow 子项会增长到 AtMost 约束内，从而膨胀基准（破坏了 YGMinMaxDimensionTest flex_grow_in_at_most 中 flexGrow:1 子项应保持基准 0 而非增长到 100 的测试）。
  let mainConstraint = NaN
  let mainConstraintMode: MeasureMode = MeasureMode.Undefined
  if (isMainRow && isDefined(availableMain) && hasMeasureFuncInSubtree(child)) {
    mainConstraint = availableMain
    mainConstraintMode = MeasureMode.AtMost
  }

  const mw = isMainRow ? mainConstraint : crossConstraint
  const mh = isMainRow ? crossConstraint : mainConstraint
  const mwMode = isMainRow ? mainConstraintMode : crossConstraintMode
  const mhMode = isMainRow ? crossConstraintMode : mainConstraintMode

  layoutNode(child, mw, mh, mwMode, mhMode, ownerWidth, ownerHeight, false)
  const b = isMainRow ? child.layout.width : child.layout.height
  child._fbBasis = b
  child._fbOwnerW = ownerWidth
  child._fbOwnerH = ownerHeight
  child._fbAvailMain = availableMain
  child._fbAvailCross = availableCross
  child._fbCrossMode = crossMode
  child._fbGen = _generation
  return b
}

/** 判断是否满足 has Measure Func In Subtree 对应的数据或状态。 */
function hasMeasureFuncInSubtree(node: Node): boolean {
  if (node.measureFunc) return true
  for (const c of node.children) {
    if (hasMeasureFuncInSubtree(c)) return true
  }
  return false
}

/** 确定 resolve Flexible Lengths 对应的数据或状态。 */
function resolveFlexibleLengths(
  children: Node[],
  availableInnerMain: number,
  totalFlexBasis: number,
  isMainRow: boolean,
  ownerW: number,
  ownerH: number,
): void {
  // 根据 CSS flexbox 规范 §9.7“解决弹性长度”进行多轮弹性分配：分配剩余空间，检测最小值/最大值违规，冻结所有违规项，在未冻结的子项中重新分配。重复直至稳定。
  const n = children.length
  const frozen: boolean[] = new Array(n).fill(false)
  const initialFree = isDefined(availableInnerMain)
    ? availableInnerMain - totalFlexBasis
    : 0
  // 将非弹性项冻结在其钳制后的基准值
  for (let i = 0; i < n; i++) {
    const c = children[i]!
    const clamped = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
    const inflexible =
      !isDefined(availableInnerMain) ||
      (initialFree >= 0 ? c.style.flexGrow === 0 : c.style.flexShrink === 0)
    if (inflexible) {
      c._mainSize = Math.max(0, clamped)
      frozen[i] = true
    } else {
      c._mainSize = c._flexBasis
    }
  }
  // 迭代分配直至无违规。每轮重新计算剩余空间：初始剩余空间减去冻结子项超出（或低于）其基准值的差值。
  const unclamped: number[] = new Array(n)
  for (let iter = 0; iter <= n; iter++) {
    let frozenDelta = 0
    let totalGrow = 0
    let totalShrinkScaled = 0
    let unfrozenCount = 0
    for (let i = 0; i < n; i++) {
      const c = children[i]!
      if (frozen[i]) {
        frozenDelta += c._mainSize - c._flexBasis
      } else {
        totalGrow += c.style.flexGrow
        totalShrinkScaled += c.style.flexShrink * c._flexBasis
        unfrozenCount++
      }
    }
    if (unfrozenCount === 0) break
    let remaining = initialFree - frozenDelta
    // 规范 §9.7 步骤 4c：如果弹性因子之和 < 1，仅分配 initialFree × sum，而非全部剩余空间（部分弹性）。
    if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
      const scaled = initialFree * totalGrow
      if (scaled < remaining) remaining = scaled
    } else if (remaining < 0 && totalShrinkScaled > 0) {
      let totalShrink = 0
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) totalShrink += children[i]!.style.flexShrink
      }
      if (totalShrink < 1) {
        const scaled = initialFree * totalShrink
        if (scaled > remaining) remaining = scaled
      }
    }
    // 计算所有未冻结子项的目标值及违规情况
    let totalViolation = 0
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const c = children[i]!
      let t = c._flexBasis
      if (remaining > 0 && totalGrow > 0) {
        t += (remaining * c.style.flexGrow) / totalGrow
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        t +=
          (remaining * (c.style.flexShrink * c._flexBasis)) / totalShrinkScaled
      }
      unclamped[i] = t
      const clamped = Math.max(
        0,
        boundAxis(c.style, isMainRow, t, ownerW, ownerH),
      )
      c._mainSize = clamped
      totalViolation += clamped - t
    }
    // 根据规范 §9.7 步骤 5 冻结：如果 totalViolation 为零则全部冻结；如果为正则冻结最小违规项；如果为负则冻结最大违规项。
    if (totalViolation === 0) break
    let anyFrozen = false
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const v = children[i]!._mainSize - unclamped[i]!
      if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
        frozen[i] = true
        anyFrozen = true
      }
    }
    if (!anyFrozen) break
  }
}

/** 判断是否满足 is Stretch Align 对应的数据或状态。 */
function isStretchAlign(child: Node): boolean {
  const p = child.parent
  if (!p) return false
  const align =
    child.style.alignSelf === Align.Auto
      ? p.style.alignItems
      : child.style.alignSelf
  return align === Align.Stretch
}

/** 确定 resolve Child Align 对应的数据或状态。 */
function resolveChildAlign(parent: Node, child: Node): Align {
  return child.style.alignSelf === Align.Auto
    ? parent.style.alignItems
    : child.style.alignSelf
}

// 根据 CSS Flexbox §8.5 / yoga 的 YGBaseline 计算节点基线。叶节点（无子项）使用自身高度。容器递归到第一行中第一个基线对齐的子项（如果没有基线对齐的子项则取第一个流式子项），返回该子项的基线加上其顶部偏移。
function calculateBaseline(node: Node): number {
  let baselineChild: Node | null = null
  for (const c of node.children) {
    if (c._lineIndex > 0) break
    if (c.style.positionType === PositionType.Absolute) continue
    if (c.style.display === Display.None) continue
    if (
      resolveChildAlign(node, c) === Align.Baseline ||
      c.isReferenceBaseline_
    ) {
      baselineChild = c
      break
    }
    if (baselineChild === null) baselineChild = c
  }
  if (baselineChild === null) return node.layout.height
  return calculateBaseline(baselineChild) + baselineChild.layout.top
}

// 容器仅在行方向并且 align-items 为 baseline 或任何流式子项设置了 align-self: baseline 时才使用基线布局。
function isBaselineLayout(node: Node, flowChildren: Node[]): boolean {
  if (!isRow(node.style.flexDirection)) return false
  if (node.style.alignItems === Align.Baseline) return true
  for (const c of flowChildren) {
    if (c.style.alignSelf === Align.Baseline) return true
  }
  return false
}

/** 执行 child Margin For Axis 对应的业务处理。 */
function childMarginForAxis(
  child: Node,
  axis: FlexDirection,
  ownerWidth: number,
): number {
  if (!child._hasMargin) return 0
  const lead = resolveEdge(child.style.margin, leadingEdge(axis), ownerWidth)
  const trail = resolveEdge(child.style.margin, trailingEdge(axis), ownerWidth)
  return lead + trail
}

/** 确定 resolve Gap 对应的数据或状态。 */
function resolveGap(style: Style, gutter: Gutter, ownerSize: number): number {
  let v = style.gap[gutter]!
  if (v.unit === Unit.Undefined) v = style.gap[Gutter.All]!
  const r = resolveValue(v, ownerSize)
  return isDefined(r) ? Math.max(0, r) : 0
}

/** 执行 bound Axis 对应的业务处理。 */
function boundAxis(
  style: Style,
  isWidth: boolean,
  value: number,
  ownerWidth: number,
  ownerHeight: number,
): number {
  const minV = isWidth ? style.minWidth : style.minHeight
  const maxV = isWidth ? style.maxWidth : style.maxHeight
  const minU = minV.unit
  const maxU = maxV.unit
  // 快速路径：未设置最小/最大约束。根据 CPU 分析，这是绝大多数情况（在 1000 节点基准测试中约 32k 次调用/布局，几乎所有 min/max 都未定义）——跳过始终无操作的 2× resolveValue + 2× isNaN。Unit.Undefined = 0。
  if (minU === 0 && maxU === 0) return value
  const owner = isWidth ? ownerWidth : ownerHeight
  let v = value
  // 内联 resolveValue：Unit.Point=1，Unit.Percent=2。`m === m` 是 !isNaN。
  if (maxU === 1) {
    if (v > maxV.value) v = maxV.value
  } else if (maxU === 2) {
    const m = (maxV.value * owner) / 100
    if (m === m && v > m) v = m
  }
  if (minU === 1) {
    if (v < minV.value) v = minV.value
  } else if (minU === 2) {
    const m = (minV.value * owner) / 100
    if (m === m && v < m) v = m
  }
  return v
}

/** 执行 zero Layout Recursive 对应的业务处理。 */
function zeroLayoutRecursive(node: Node): void {
  for (const c of node.children) {
    c.layout.left = 0
    c.layout.top = 0
    c.layout.width = 0
    c.layout.height = 0
    // 使布局缓存失效——否则，取消隐藏 → calculateLayout 会找到子元素是干净的（!isDirty_）且 _hasL 完整，在 ~1086 行命中缓存，恢复过时的 _lOutW/_lOutH 并提前返回——跳过了子元素定位递归。孙元素保留在上面的归零中的 (0,0,0,0)，渲染为不可见。isDirty_=true 还通过 (sameGen || !isDirty_) 检查控制 _cN 和 _fbBasis——_cGen/_fbGen 在隐藏期间冻结，所以取消隐藏时 sameGen 为 false。
    c.isDirty_ = true
    c._hasL = false
    c._hasM = false
    zeroLayoutRecursive(c)
  }
}

/** 合并或收集 collect Layout Children 对应的数据或状态。 */
function collectLayoutChildren(node: Node, flow: Node[], abs: Node[]): void {
  // 将节点的子节点划分为流列表和绝对列表，展平 display:contents 子树，以便它们的子节点布局为该节点的直接子节点（根据 CSS display:contents 规范——该盒子从布局树中移除，但其子节点保留，提升到祖父节点）。
  for (const c of node.children) {
    const disp = c.style.display
    if (disp === Display.None) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      zeroLayoutRecursive(c)
    } else if (disp === Display.Contents) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      // 递归——嵌套的 display:contents 一直提升到顶层。内容节点自身的 margin/padding/position/dimensions 被忽略。
      collectLayoutChildren(c, flow, abs)
    } else if (c.style.positionType === PositionType.Absolute) {
      abs.push(c)
    } else {
      flow.push(c)
    }
  }
}

/** 执行 round Layout 对应的业务处理。 */
function roundLayout(
  node: Node,
  scale: number,
  absLeft: number,
  absTop: number,
): void {
  if (scale === 0) return
  const l = node.layout
  const nodeLeft = l.left
  const nodeTop = l.top
  const nodeWidth = l.width
  const nodeHeight = l.height

  const absNodeLeft = absLeft + nodeLeft
  const absNodeTop = absTop + nodeTop

  // 上游 YGRoundValueToPixelGrid：文本节点（具有 measureFunc）对位置进行向下取整，以便换行文本永远不会超过其分配的列。宽度使用向上取整以避免裁剪最后一个字形。非文本节点使用标准四舍五入。与 yoga 的 PixelGrid.cpp 匹配——没有这一点，justify center/space-evenly 位置与 WASM 相比会偏差一个像素，并且 flex-shrink 溢出会将兄弟节点放置在错误的列。
  const isText = node.measureFunc !== null
  l.left = roundValue(nodeLeft, scale, false, isText)
  l.top = roundValue(nodeTop, scale, false, isText)

  // 通过绝对边缘舍入宽度/高度以避免累积漂移
  const absRight = absNodeLeft + nodeWidth
  const absBottom = absNodeTop + nodeHeight
  const hasFracW = !isWholeNumber(nodeWidth * scale)
  const hasFracH = !isWholeNumber(nodeHeight * scale)
  l.width =
    roundValue(absRight, scale, isText && hasFracW, isText && !hasFracW) -
    roundValue(absNodeLeft, scale, false, isText)
  l.height =
    roundValue(absBottom, scale, isText && hasFracH, isText && !hasFracH) -
    roundValue(absNodeTop, scale, false, isText)

  for (const c of node.children) {
    roundLayout(c, scale, absNodeLeft, absNodeTop)
  }
}

/** 判断是否满足 is Whole Number 对应的数据或状态。 */
function isWholeNumber(v: number): boolean {
  const frac = v - Math.floor(v)
  return frac < 0.0001 || frac > 0.9999
}

/** 执行 round Value 对应的业务处理。 */
function roundValue(
  v: number,
  scale: number,
  forceCeil: boolean,
  forceFloor: boolean,
): number {
  let scaled = v * scale
  let frac = scaled - Math.floor(scaled)
  if (frac < 0) frac += 1
  // 浮点 epsilon 容差匹配上游 YGDoubleEqual（1e-4）
  if (frac < 0.0001) {
    scaled = Math.floor(scaled)
  } else if (frac > 0.9999) {
    scaled = Math.ceil(scaled)
  } else if (forceCeil) {
    scaled = Math.ceil(scaled)
  } else if (forceFloor) {
    scaled = Math.floor(scaled)
  } else {
    // 四舍五入（>= 0.5 向上入），按照上游
    scaled = Math.floor(scaled) + (frac >= 0.4999 ? 1 : 0)
  }
  return scaled / scale
}

// --
// 辅助函数

function parseDimension(v: number | string | undefined): Value {
  if (v === undefined) return UNDEFINED_VALUE
  if (v === 'auto') return AUTO_VALUE
  if (typeof v === 'number') {
    // WASM yoga 的 YGFloatIsUndefined 将 NaN 和 ±Infinity 视为未定义。Ink 传入 height={Infinity}（例如 LogSelector 的 maxHeight 默认值），并期望它意味着“无约束”——将其存储为字面点值会使节点高度为 Infinity 并破坏所有下游布局。
    return Number.isFinite(v) ? pointValue(v) : UNDEFINED_VALUE
  }
  if (typeof v === 'string' && v.endsWith('%')) {
    return percentValue(parseFloat(v))
  }
  const n = parseFloat(v)
  return isNaN(n) ? UNDEFINED_VALUE : pointValue(n)
}

/** 执行 physical Edge 对应的业务处理。 */
function physicalEdge(edge: Edge): number {
  switch (edge) {
    case Edge.Left:
    case Edge.Start:
      return EDGE_LEFT
    case Edge.Top:
      return EDGE_TOP
    case Edge.Right:
    case Edge.End:
      return EDGE_RIGHT
    case Edge.Bottom:
      return EDGE_BOTTOM
    default:
      return EDGE_LEFT
  }
}

// --
// 模块 API 匹配 yoga-layout/load

export type Yoga = {
  Config: {
    /** 创建 create 对应的数据或状态。 */
    create(): Config
    /** 删除或清理 destroy 对应的数据或状态。 */
    destroy(config: Config): void
  }
  Node: {
    /** 创建 create 对应的数据或状态。 */
    create(config?: Config): Node
    /** 创建 create Default 对应的数据或状态。 */
    createDefault(): Node
    /** 创建 create With Config 对应的数据或状态。 */
    createWithConfig(config: Config): Node
    /** 删除或清理 destroy 对应的数据或状态。 */
    destroy(node: Node): void
  }
}

const YOGA_INSTANCE: Yoga = {
  Config: {
    create: createConfig,
    /** 删除或清理 destroy 对应的数据或状态。 */
    destroy() {},
  },
  Node: {
    /** 创建 create 对应的数据或状态。 */
    create: (config?: Config) => new Node(config),
    /** 创建 create Default 对应的数据或状态。 */
    createDefault: () => new Node(),
    /** 创建 create With Config 对应的数据或状态。 */
    createWithConfig: (config: Config) => new Node(config),
    /** 删除或清理 destroy 对应的数据或状态。 */
    destroy() {},
  },
}

/** 获取 load Yoga 对应的数据或状态。 */
export function loadYoga(): Promise<Yoga> {
  return Promise.resolve(YOGA_INSTANCE)
}

export default YOGA_INSTANCE
