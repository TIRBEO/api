import { prisma } from './lib/db/prisma'
async function seed() {
  // Check if config exists
  const existing = await prisma.emailConfig.findFirst()
  if (existing) {
    console.log('Email config already exists')
    await prisma.$disconnect()
    return
  }
  
  // Create default config
  const config = await prisma.emailConfig.create({
    data: {
      provider: 'resend',
      resendApiKey: process.env.RESEND_API_KEY || '',
      defaultFromEmail: 'noreply@send.tirbeo.app',
      defaultFromName: 'Tirbeo',
      welcomeFromEmail: 'welcome@send.tirbeo.app',
      welcomeFromName: 'Tirbeo Team',
      otpFromEmail: 'verify@send.tirbeo.app',
      otpFromName: 'Tirbeo',
      resetFromEmail: 'reset@send.tirbeo.app',
      resetFromName: 'Tirbeo Security',
      enabled: true,
    },
  })
  console.log('Email config created:', config.id)
  await prisma.$disconnect()
}
seed()
