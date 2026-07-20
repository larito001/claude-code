import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const repeatPaginationCursor = process.argv.includes(
  '--repeat-pagination-cursor',
)

const server = new Server(
  { name: 'core-smoke-server', version: '1.0.0' },
  {
    capabilities: {
      prompts: { listChanged: true },
      resources: { listChanged: true },
      tools: { listChanged: true },
    },
  },
)

server.setRequestHandler(ListToolsRequestSchema, async request => {
  if (!request.params?.cursor) {
    return {
      tools: [
        {
          name: 'echo',
          description: 'Echo a value through a real MCP stdio connection',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
      ],
      nextCursor: 'tools-page-2',
    }
  }
  if (request.params.cursor === 'tools-page-2') {
    return {
      tools: [
        {
          name: 'uppercase',
          description: 'Uppercase a value from the second tool page',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
    }
  }
  throw new Error(`Unknown tools cursor: ${request.params.cursor}`)
})

server.setRequestHandler(CallToolRequestSchema, async request => {
  const value = request.params.arguments?.value
  if (typeof value !== 'string') {
    throw new Error('value must be a string')
  }
  if (request.params.name === 'uppercase') {
    return {
      content: [{ type: 'text', text: `MCP_UPPERCASE:${value.toUpperCase()}` }],
    }
  }
  if (request.params.name !== 'echo') {
    throw new Error(`Unknown tool: ${request.params.name}`)
  }
  return {
    content: [{ type: 'text', text: `MCP_ECHO:${value}` }],
    structuredContent: { echoed: value },
  }
})

server.setRequestHandler(ListResourcesRequestSchema, async request => {
  if (!request.params?.cursor) {
    return {
      resources: [
        {
          uri: 'smoke://framework',
          name: 'Commercial framework smoke resource',
          mimeType: 'text/plain',
        },
      ],
      nextCursor: repeatPaginationCursor ? 'repeat' : 'resources-page-2',
    }
  }
  if (repeatPaginationCursor && request.params.cursor === 'repeat') {
    return { resources: [], nextCursor: 'repeat' }
  }
  if (request.params.cursor === 'resources-page-2') {
    return {
      resources: [
        {
          uri: 'smoke://page-two',
          name: 'Second-page smoke resource',
          mimeType: 'text/plain',
        },
      ],
    }
  }
  throw new Error(`Unknown resources cursor: ${request.params.cursor}`)
})

server.setRequestHandler(ReadResourceRequestSchema, async request => {
  if (
    request.params.uri !== 'smoke://framework' &&
    request.params.uri !== 'smoke://page-two'
  ) {
    throw new Error(`Unknown resource: ${request.params.uri}`)
  }
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: 'text/plain',
        text:
          request.params.uri === 'smoke://page-two'
            ? 'MCP_RESOURCE_PAGE_TWO_OK'
            : 'MCP_RESOURCE_OK',
      },
    ],
  }
})

server.setRequestHandler(ListPromptsRequestSchema, async request => {
  if (!request.params?.cursor) {
    return {
      prompts: [
        {
          name: 'core-review',
          description: 'Build a commercial-core review prompt',
          arguments: [{ name: 'target', required: true }],
        },
      ],
      nextCursor: 'prompts-page-2',
    }
  }
  if (request.params.cursor === 'prompts-page-2') {
    return {
      prompts: [
        {
          name: 'core-plan',
          description: 'Build a plan from the second prompt page',
          arguments: [{ name: 'target', required: true }],
        },
      ],
    }
  }
  throw new Error(`Unknown prompts cursor: ${request.params.cursor}`)
})

server.setRequestHandler(GetPromptRequestSchema, async request => ({
  description: 'Commercial-core review prompt',
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `${
          request.params.name === 'core-plan'
            ? 'MCP_PROMPT_PAGE_TWO_OK'
            : 'MCP_PROMPT_OK'
        }:${request.params.arguments?.target ?? ''}`,
      },
    },
  ],
}))

await server.connect(new StdioServerTransport())
