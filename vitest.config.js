import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      reporter: ['text', 'html'],
      include: ['core/**/*.js', 'platforms/runway/transport.js']
    }
  }
});
