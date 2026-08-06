import { prisma } from './lib/db/prisma'

async function check() {
  try {
    // List all tables
    const tables = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `
    console.log('All tables:')
    ;(tables as any[]).forEach((t: any) => console.log(' -', t.table_name))
    
    // Check specifically for captcha tables
    const captchaTables = await prisma.$queryRaw`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE '%aptcha%'
      ORDER BY table_name;
    `
    console.log('\nCaptcha tables:')
    ;(captchaTables as any[]).forEach((t: any) => console.log(' -', t.table_name))

    await prisma.$disconnect()
  } catch (err: any) {
    console.error('Error:', err.message)
    await prisma.$disconnect()
  }
}
check()
