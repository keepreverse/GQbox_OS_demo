import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  base: '/GQbox_OS_demo/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@components": path.resolve(__dirname, "src/components"),
      "@features": path.resolve(__dirname, "src/features"),
      "@data": path.resolve(__dirname, "src/data"),
      "@app-types": path.resolve(__dirname, "src/types"),
      "@context": path.resolve(__dirname, "src/context"),
      "@hooks": path.resolve(__dirname, "src/hooks"),
      "@utils": path.resolve(__dirname, "src/utils"),
      "@constants": path.resolve(__dirname, "src/constants"),
      "@api": path.resolve(__dirname, "src/api"),
      "@i18n": path.resolve(__dirname, "src/i18n"),
    },
  },
  server: {
    proxy: {
      // Без явного `configure` большие multipart-загрузки (фото) рвутся
      // с ERR_CONNECTION_RESET. http-proxy по умолчанию ставит timeout
      // на proxyReq/proxyRes и буферизует тело — для 2-5MB картинок это
      // становится заметно. Отключаем таймаут прокси и буферизацию,
      // чтобы тело стримилось напрямую к Express-серверу.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        ws: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('connection', 'keep-alive');
          });
        },
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
      },
    },
    // Vite dev-сервер сам по себе может рвать коннект на больших телах.
    // Поднимаем лимит и выключаем буферизацию для стабильной загрузки.
    hmr: { overlay: true },
    watch: {
      ignored: [
        '**/server/data/**',
        '**/server/uploads/**',
      ],
    },
  },
});
