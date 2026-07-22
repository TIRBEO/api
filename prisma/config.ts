import { definePrismaConfig } from '@prisma/config';
import { defineConfig } from 'next';

export const prismaConfig = definePrismaConfig({
  datasource: {
    url: process.env.DATABASE_URL,
    adapter: process.env.DATABASE_URL.includes('postgresql://') ? 'postgresql' : undefined,
  },
});

export default defineConfig({
  // Rest of next.config.js
});
