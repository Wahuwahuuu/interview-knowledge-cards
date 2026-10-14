import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node', pool: 'threads', maxWorkers: 1 }, esbuild: { target: 'es2022' } });
