import { prisma } from './lib/db/prisma'

async function test() {
  try {
    const result = await prisma.$queryRaw`SELECT 1 as test`
    console.log('DB Connection OK:', result)
    const settings = await prisma.captchaSettings.findFirst({ where: { key: 'global' } })
    console.log('Captcha settings:', settings ? 'EXISTS' : 'NOT FOUND')
    await prisma.$disconnect()
  } catch (err: any) {
    console.error('DB Error:', err.message)
    await prisma.$disconnect()
  }
}
test()
