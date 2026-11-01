import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // esbuild does not read emitDecoratorMetadata from tsconfig; Nest's DI needs
    // the legacy decorator transform to be explicitly enabled here.
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'node',
        esModuleInterop: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
  },
});
