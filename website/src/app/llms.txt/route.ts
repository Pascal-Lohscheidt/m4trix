import { buildLlmsTxt } from '@/lib/docs/llm';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(await buildLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
