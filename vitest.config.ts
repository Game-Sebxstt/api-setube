import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: path.join(os.tmpdir(), 'setube-vite-cache'),
  test: {
    // vitest 5: la caché de módulos transformados (por defecto node_modules/.vitest-cache, de root en api-dev) también va a tmp
    fsModuleCachePath: path.join(os.tmpdir(), 'setube-vitest-cache'),
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
      // comparten SETUBE_TMP (constante) y Redis de test: un archivo a la vez
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.test.ts'], environment: 'node', fileParallelism: false } },
    ],
  },
});
