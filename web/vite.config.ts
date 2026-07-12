import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-server proxy. The React app is served on :5173, the API on :3000.
    // When the browser requests /accounts (or /health), Vite forwards it to the
    // backend. So from the app's perspective everything is one origin: no CORS
    // setup on the server, and no hardcoded http://localhost:3000 in fetch calls.
    // (As more backend routes appear, either list them here or switch to an /api prefix.)
    proxy: {
      '/accounts': 'http://localhost:3000',
      '/transactions': 'http://localhost:3000',
      '/transfers': 'http://localhost:3000',
      '/anomalies': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
