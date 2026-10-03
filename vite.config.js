import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react-swc';
import { execSync } from 'child_process';
import path from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(({ mode }) => {
  // eslint-disable-next-line no-undef
  const env = loadEnv(mode, process.cwd(), '');

  // RELATIVE_BASE=true emits relative asset URLs so the build works under a sub-path or a Swarm root.
  const relativeBase = env.RELATIVE_BASE === 'true';
  // VITE_DEBUG_PANEL=true turns on the segment debug panel; the commit is shown in its header.
  const debugPanel = env.VITE_DEBUG_PANEL === 'true';
  let gitCommit = env.VITE_GIT_COMMIT || '';
  if (debugPanel && !gitCommit) {
    try {
      gitCommit = execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      gitCommit = 'unknown';
    }
  }

  const htmlPlugin = () => {
    return {
      name: 'html-transform',
      transformIndexHtml(html) {
        return html.replace('%VITE_THEME%', env.VITE_THEME || 'cryptomondays');
      },
    };
  };

  return {
    base: relativeBase ? './' : '/',
    ...(debugPanel && { define: { 'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit) } }),
    server: {
      host: true,
      port: 5175,
      strictPort: false,
    },
    plugins: [
      nodePolyfills(),
      react(),
      basicSsl(),
      htmlPlugin(),
      // Add bundle analyzer (only in analyze mode)
      // eslint-disable-next-line no-undef
      ...(process.env.ANALYZE
        ? [
            visualizer({
              open: true,
              filename: 'dist/stats.html',
              gzipSize: true,
              brotliSize: true,
            }),
          ]
        : []),
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: true,
      include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
      exclude: ['node_modules', 'dist'],
    },
  };
});
