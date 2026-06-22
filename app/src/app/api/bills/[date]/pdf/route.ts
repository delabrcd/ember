import fs from 'fs';
import { NextResponse } from 'next/server';
import { withAccount } from '@/lib/route';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Stream a bill PDF, scoped to ?accountId= (omitted = the default account, same as
// GET /api/bills) so a multi-account install resolves the date against — and serves
// — the correct premise's PDF instead of always the lowest-id account (issue #159).
// `withAccount`'s no-account path preserves the historical 404 "No account".
export async function GET(req: Request, { params }: { params: { date: string } }) {
  return withAccount(
    req.url,
    () => new NextResponse('No account', { status: 404 }),
    async (acct) => {
      const statementDate = new Date(params.date + 'T00:00:00Z');
      const bill = await prisma.bill.findUnique({
        where: { accountId_statementDate: { accountId: acct.id, statementDate } },
      });
      if (!bill?.pdfPath || !fs.existsSync(bill.pdfPath)) {
        return new NextResponse('PDF not found', { status: 404 });
      }
      const buf = fs.readFileSync(bill.pdfPath);
      return new NextResponse(buf, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="national-grid-${params.date}.pdf"`,
          'cache-control': 'private, max-age=86400',
        },
      });
    }
  );
}
