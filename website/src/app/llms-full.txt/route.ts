import { buildLlmsFullTxt } from '@/lib/docs/llm';

export const dynamic = 'force-static';

export async function GET() {
  return new Response(await buildLlmsFullTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
