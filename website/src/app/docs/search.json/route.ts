import { buildSearchRecords } from '@/lib/docs/search';

export const dynamic = 'force-static';

export async function GET() {
  return Response.json(await buildSearchRecords());
}
