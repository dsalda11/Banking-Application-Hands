import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/**/*.surface.test.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
