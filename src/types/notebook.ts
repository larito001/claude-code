export type NotebookCellType = 'code' | 'markdown' | 'raw'
export type NotebookCellSource = string | string[]
export type NotebookCellSourceOutput = string | string[]

export type NotebookOutputImage = {
  mimeType: string
  data: string
}

export type NotebookCellOutput = {
  output_type?: string
  data?: Record<string, unknown>
  text?: NotebookCellSourceOutput
  [key: string]: unknown
}

export type NotebookCell = {
  cell_type: NotebookCellType
  source: NotebookCellSource
  outputs?: NotebookCellOutput[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type NotebookContent = {
  cells: NotebookCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}
