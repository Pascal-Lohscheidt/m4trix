import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      message: 'tRPC API example not implemented yet.',
    },
    { status: 501 },
  );
}

export const POST = GET;
