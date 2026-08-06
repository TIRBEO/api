import { prisma } from './lib/db/prisma'

async function test() {
  try {
    const result = await prisma.$queryRaw`
      EXPLAIN ANALYZE
      SELECT * FROM captcha_blocks
      WHERE session_id = 'test-session'
        AND blocked_at <= NOW()
        AND unblocked_at IS NULL
        AND (expires_at IS NULL OR expires_at >= NOW())
      ORDER BY blocked_at DESC
      LIMIT 1;
    `
    console.log('Query plan:')
    ;(result as any[]).forEach((r: any) => console.log(r['QUERY PLAN']))
    await prisma.$disconnect()
  } catch (err: any) {
    console.error('Error:', err.message)
    await prisma.$disconnect()
  }
}
test()
