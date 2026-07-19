import { z } from 'zod/v4'
import { HooksSchema } from '../../schemas/hooks.js'
import { McpServerConfigSchema } from '../../services/mcp/types.js'
import { lazySchema } from '../lazySchema.js'

const RelativePath = lazySchema(() =>
  z.string().startsWith('./', 'Plugin component paths must start with "./"'),
)
const RelativeJsonPath = lazySchema(() =>
  RelativePath().endsWith('.json', 'Expected a JSON file path'),
)
const RelativeMarkdownPath = lazySchema(() =>
  RelativePath().endsWith('.md', 'Expected a Markdown file path'),
)

export const PluginAuthorSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
)

export const PluginHooksSchema = lazySchema(() =>
  z.object({
    description: z.string().optional(),
    hooks: HooksSchema(),
  }),
)

export const CommandMetadataSchema = lazySchema(() =>
  z
    .object({
      source: RelativePath().optional(),
      content: z.string().optional(),
      description: z.string().optional(),
      argumentHint: z.string().optional(),
      model: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
    })
    .refine(
      value => Boolean(value.source) !== Boolean(value.content),
      'Command must define exactly one of source or content',
    ),
)

const nonEmptyString = lazySchema(() => z.string().min(1))
const fileExtension = lazySchema(() =>
  z.string().min(2).startsWith('.', 'File extensions must start with a dot'),
)
const localPluginName = lazySchema(() =>
  z
    .string()
    .min(1)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      'Local plugin names may contain letters, numbers, dots, underscores, and hyphens',
    ),
)

export const LspServerConfigSchema = lazySchema(() =>
  z.strictObject({
    command: z.string().min(1),
    args: z.array(nonEmptyString()).optional(),
    extensionToLanguage: z
      .record(fileExtension(), nonEmptyString())
      .refine(value => Object.keys(value).length > 0),
    transport: z.enum(['stdio', 'socket']).default('stdio'),
    env: z.record(z.string(), z.string()).optional(),
    initializationOptions: z.unknown().optional(),
    settings: z.unknown().optional(),
    workspaceFolder: z.string().optional(),
    startupTimeout: z.number().int().positive().optional(),
    shutdownTimeout: z.number().int().positive().optional(),
    restartOnCrash: z.boolean().optional(),
    maxRestarts: z.number().int().nonnegative().optional(),
  }),
)

const hooksDeclaration = lazySchema(() =>
  z.union([
    RelativeJsonPath(),
    HooksSchema(),
    z.array(z.union([RelativeJsonPath(), HooksSchema()])),
  ]),
)
const commandDeclaration = lazySchema(() =>
  z.union([
    RelativePath(),
    z.array(RelativePath()),
    z.record(z.string(), CommandMetadataSchema()),
  ]),
)
const markdownDeclaration = lazySchema(() =>
  z.union([RelativeMarkdownPath(), z.array(RelativeMarkdownPath())]),
)
const pathDeclaration = lazySchema(() =>
  z.union([RelativePath(), z.array(RelativePath())]),
)
const mcpDeclaration = lazySchema(() =>
  z.union([
    RelativeJsonPath(),
    z.record(z.string(), McpServerConfigSchema()),
    z.array(
      z.union([
        RelativeJsonPath(),
        z.record(z.string(), McpServerConfigSchema()),
      ]),
    ),
  ]),
)
const lspDeclaration = lazySchema(() =>
  z.union([
    RelativeJsonPath(),
    z.record(z.string(), LspServerConfigSchema()),
    z.array(
      z.union([
        RelativeJsonPath(),
        z.record(z.string(), LspServerConfigSchema()),
      ]),
    ),
  ]),
)

/** Runtime schema for a local plugin loaded from --plugin-dir. */
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    name: localPluginName(),
    version: z.string().optional(),
    description: z.string().optional(),
    author: PluginAuthorSchema().optional(),
    homepage: z.string().url().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    dependencies: z
      .array(
        localPluginName(),
      )
      .optional(),
    hooks: hooksDeclaration().optional(),
    commands: commandDeclaration().optional(),
    agents: markdownDeclaration().optional(),
    skills: pathDeclaration().optional(),
    outputStyles: pathDeclaration().optional(),
    mcpServers: mcpDeclaration().optional(),
    lspServers: lspDeclaration().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
)

export type CommandMetadata = z.infer<ReturnType<typeof CommandMetadataSchema>>
export type PluginAuthor = z.infer<ReturnType<typeof PluginAuthorSchema>>
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
