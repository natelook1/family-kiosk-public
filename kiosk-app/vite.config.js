import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/webhook': {
        target: 'https://family.looknet.ca',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
