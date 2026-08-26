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
    // WARNING: a path missing from this list does NOT fail loudly. Vite falls back to
    // serving index.html, so the request returns 200 with HTML and the failure surfaces
    // far away as "JSON.parse: unexpected character" in whichever component fetched it.
    // Checking the status code through this proxy proves nothing — check the body.
    // This list is a second place to remember; an /api prefix would remove it entirely.
    proxy: {
      '/accounts': 'http://localhost:3000',
      '/categories': 'http://localhost:3000',
      '/transactions': 'http://localhost:3000',
      '/transfers': 'http://localhost:3000',
      '/anomalies': 'http://localhost:3000',
      '/rules': 'http://localhost:3000',
      '/summary': 'http://localhost:3000',
      '/reports': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
