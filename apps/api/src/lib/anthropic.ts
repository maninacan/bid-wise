import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-opus-4-8';

let client: Anthropic | null = null;

/** Lazily constructs a shared Anthropic client. Throws if the key is missing. */
export function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set.');
  if (!client) client = new Anthropic({ apiKey });
  return client;
}
