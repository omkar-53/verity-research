import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createService } from './server/service.mjs';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const connect = async server => {
    const service = await createService(env);
    server.middlewares.use('/api',service.app);
    server.httpServer?.once('close',()=>void service.close());
  };
  return { plugins: [react(), {name:'verity-research-api',configureServer:connect,configurePreviewServer:connect}] };
});
