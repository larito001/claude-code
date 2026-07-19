/** Jupyter Notebook 支持的标准单元格类型。 */
export type NotebookCellType = 'code' | 'markdown' | 'raw'

/** Notebook JSON 中原始 source 字段的两种合法形式。 */
export type NotebookRawSource = string | string[]

/** 代码单元的标准输出文本。 */
export type NotebookRawOutputText = string | string[]

/** Jupyter stream 输出。 */
export type NotebookStreamOutput = {
  output_type: 'stream'
  name?: 'stdout' | 'stderr'
  text?: NotebookRawOutputText
}

/** Jupyter 展示数据或执行结果输出。 */
export type NotebookDisplayOutput = {
  output_type: 'execute_result' | 'display_data'
  data?: Record<string, string | string[] | undefined>
  metadata?: Record<string, unknown>
  execution_count?: number | null
}

/** Jupyter 执行错误输出。 */
export type NotebookErrorOutput = {
  output_type: 'error'
  ename: string
  evalue: string
  traceback: string[]
}

/** Notebook JSON 中单个代码单元的输出联合。 */
export type NotebookCellOutput =
  | NotebookStreamOutput
  | NotebookDisplayOutput
  | NotebookErrorOutput

/** Notebook JSON 中的原始单元格。 */
export type NotebookCell = {
  cell_type: NotebookCellType
  source: NotebookRawSource
  metadata: Record<string, unknown>
  id?: string
  execution_count?: number | null
  outputs?: NotebookCellOutput[]
}

/** Notebook 语言元数据。 */
export type NotebookMetadata = Record<string, unknown> & {
  language_info?: Record<string, unknown> & {
    name?: string
  }
}

/** 从 .ipynb 文件读取的完整标准结构。 */
export type NotebookContent = {
  cells: NotebookCell[]
  metadata: NotebookMetadata
  nbformat: number
  nbformat_minor: number
}

/** 转换后可直接发送给模型的 base64 图像。 */
export type NotebookOutputImage = {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

/** 经过截断和图像提取后的单元格输出。 */
export type NotebookCellSourceOutput = {
  output_type: NotebookCellOutput['output_type']
  text?: string
  image?: NotebookOutputImage
}

/** 供 FileReadTool 和模型上下文使用的归一化单元格。 */
export type NotebookCellSource = {
  cellType: NotebookCellType
  source: string
  execution_count?: number
  cell_id: string
  language?: string
  outputs?: NotebookCellSourceOutput[]
}
