import { TICK_TAG } from '../../constants/xml.js'

export const SLEEP_TOOL_NAME = 'Sleep'
export const DESCRIPTION = 'Wait for a specified duration'
export const SLEEP_TOOL_PROMPT = `Wait for a specified duration. The user can interrupt the sleep at any time.

Use this when the user tells you to sleep or rest, when you have nothing to do, or when you're waiting for something.

You may receive <${TICK_TAG}> prompts — these are periodic check-ins. Look for useful work to do before sleeping.

The sleep ends early when a user message or background task notification arrives. Use this instead of polling a task or running a shell sleep command.

You can call this concurrently with other tools — it does not hold a shell process.

Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.`
