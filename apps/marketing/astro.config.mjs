import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  outDir: '../../dist/apps/marketing',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [],
});
