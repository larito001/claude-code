import {
  EXIT_REASONS,
  HOOK_EVENTS,
  createSdkMcpServer,
  tool,
  type Options,
} from 'claude-code-core-framework'
import { z } from 'zod/v4'

const options: Options = {
  cwd: process.cwd(),
  tools: [],
}

const ping = tool(
  'consumer-ping',
  'Compile-time SDK consumer fixture',
  { value: z.string() },
  async ({ value }) => ({
    content: [{ type: 'text', text: value }],
  }),
)

const server = createSdkMcpServer({
  name: 'consumer-fixture',
  tools: [ping],
})

void [options, server, HOOK_EVENTS, EXIT_REASONS]
