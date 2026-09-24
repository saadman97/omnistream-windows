import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import path from 'path';

export default defineConfig({
  plugins: [
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
          }
        }
      }
    ]),
    renderer(),
  ],
  build: {
    rollupOptions: {
      input: {
        browser: path.resolve(__dirname, 'browser.html'),
        settings: path.resolve(__dirname, 'settings.html'),
        player: path.resolve(__dirname, 'player.html'),
        background: path.resolve(__dirname, 'background.html'),
      }
    }
  }
});
