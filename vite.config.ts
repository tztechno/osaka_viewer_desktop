import { defineConfig, type Plugin } from 'vite';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';

const CESIUM_DIR = 'node_modules/cesium/Build/Cesium';
const CESIUM_PARTS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const MIME: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.xml': 'application/xml' };

/** Serve Cesium's static Workers/Assets under ./cesium/ in dev, copy them into dist on build. */
function cesiumStatic(): Plugin {
  let outDir = 'dist';
  return {
    name: 'cesium-static',
    configResolved(c) { outDir = c.build.outDir; },
    configureServer(server) {
      server.middlewares.use('/cesium', (req, res, next) => {
        const file = join(CESIUM_DIR, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const p of CESIUM_PARTS) cpSync(join(CESIUM_DIR, p), join(outDir, 'cesium', p), { recursive: true });
    },
  };
}

// HTTPS=1 npm run dev  -> self-signed HTTPS on the LAN, needed for geolocation /
// device orientation when testing on a phone.
export default defineConfig({
  base: './',
  plugins: [cesiumStatic(), ...(process.env.HTTPS ? [basicSsl()] : [])],
  server: { host: true },
  build: { chunkSizeWarningLimit: 6000, target: 'es2022' },
});
