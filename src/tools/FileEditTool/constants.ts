// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .claude-code-core-framework/ folder
export const FRAMEWORK_FOLDER_PERMISSION_PATTERN = '/.claude-code-core-framework/**'

// Permission pattern for granting session-level access to the global ~/.claude-code-core-framework/ folder
export const GLOBAL_FRAMEWORK_FOLDER_PERMISSION_PATTERN = '~/.claude-code-core-framework/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
