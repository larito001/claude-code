import { stat } from 'fs/promises'

import type { ValidationResult } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getErrnoCode } from '../../utils/errors.js'
import { IMAGE_EXTENSION_REGEX } from '../../utils/imagePaste.js'
import { expandPath } from '../../utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
}

export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not a regular file.`,
          errorCode: 1,
        }
      }
    } catch (error) {
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `Attachment "${rawPath}" does not exist. Current working directory: ${cwd}.`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not accessible (permission denied).`,
          errorCode: 1,
        }
      }
      throw error
    }
  }
  return { result: true }
}

export async function resolveAttachments(
  rawPaths: string[],
): Promise<ResolvedAttachment[]> {
  return Promise.all(
    rawPaths.map(async rawPath => {
      const fullPath = expandPath(rawPath)
      const stats = await stat(fullPath)
      return {
        path: fullPath,
        size: stats.size,
        isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
      }
    }),
  )
}
