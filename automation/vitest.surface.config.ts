import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.surface.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
