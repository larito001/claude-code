import { toJSONSchema } from 'zod/v4'
import { jsonStringify } from '../slowOperations.js'
import { SettingsSchema } from './types.js'

/** 执行 generate Settings JSON Schema 对应的业务处理。 */
export function generateSettingsJSONSchema(): string {
  const jsonSchema = toJSONSchema(SettingsSchema(), { unrepresentable: 'any' })
  return jsonStringify(jsonSchema, null, 2)
}
