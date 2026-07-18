export type QueueOperation = 'enqueue' | 'dequeue' | 'clear' | string

export type QueueOperationMessage = {
  type: string
  operation?: QueueOperation
  [key: string]: any
}
