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

const server = new Server(
  { name: 'core-smoke-server', version: '1.0.0' },
  { capabilities: { prompts: {}, resources: {}, tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
}))

server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name !== 'echo') {
    throw new Error(`Unknown tool: ${request.params.name}`)
  }
  const value = request.params.arguments?.value
  if (typeof value !== 'string') {
    throw new Error('value must be a string')
  }
  return {
    content: [{ type: 'text', text: `MCP_ECHO:${value}` }],
    structuredContent: { echoed: value },
  }
})

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'smoke://framework',
      name: 'Commercial framework smoke resource',
      mimeType: 'text/plain',
    },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async request => {
  if (request.params.uri !== 'smoke://framework') {
    throw new Error(`Unknown resource: ${request.params.uri}`)
  }
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: 'text/plain',
        text: 'MCP_RESOURCE_OK',
      },
    ],
  }
})

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'core-review',
      description: 'Build a commercial-core review prompt',
      arguments: [{ name: 'target', required: true }],
    },
  ],
}))

server.setRequestHandler(GetPromptRequestSchema, async request => ({
  description: 'Commercial-core review prompt',
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `MCP_PROMPT_OK:${request.params.arguments?.target ?? ''}`,
      },
    },
  ],
}))

await server.connect(new StdioServerTransport())
