import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: [{ find: '@/', replacement: path.resolve(__dirname, './') + '/' }],
  },
});
