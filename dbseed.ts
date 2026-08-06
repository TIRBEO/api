import { prisma } from './lib/db/prisma'

async function seed() {
  try {
    // Check if captchaSettings table exists
    const tableCheck = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'captchaSettings'
      );
    `
    console.log('captchaSettings table exists:', tableCheck)

    // Seed captcha settings if not exists
    const existing = await prisma.captchaSettings.findFirst({ where: { key: 'global' } })
    if (!existing) {
      const created = await prisma.captchaSettings.create({
        data: {
          key: 'global',
          value: {
            enabled: true,
            autoEnforce: true,
            riskEnabled: true,
            standardScore: 51,
            strongScore: 81,
            multiAccountThreshold: 3,
            easyThreshold: 2,
            mediumThreshold: 4,
            hardThreshold: 6,
            blockThreshold: 8,
            sessionDuration: 60,
            challengeExpiry: 2,
            maxAttemptsPerChallenge: 3,
            cooldownMinutes: 10,
            adminNotifyThreshold: 5,
          },
          description: 'Global CAPTCHA settings',
        },
      })
      console.log('Created captcha settings:', created.id)
    } else {
      console.log('Captcha settings already exist')
    }

    // Check captchaChallenge table
    const challengeTable = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'captchaChallenge'
      );
    `
    console.log('captchaChallenge table exists:', challengeTable)

    // Check captchaBlock table
    const blockTable = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'captchaBlock'
      );
    `
    console.log('captchaBlock table exists:', blockTable)

    // Check captchaLog table
    const logTable = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'captchaLog'
      );
    `
    console.log('captchaLog table exists:', logTable)

    // Check captchaAttempt table
    const attemptTable = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'captchaAttempt'
      );
    `
    console.log('captchaAttempt table exists:', attemptTable)

    await prisma.$disconnect()
  } catch (err: any) {
    console.error('Seed Error:', err.message)
    await prisma.$disconnect()
  }
}
seed()
