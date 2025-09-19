import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    router: {
      type: process.env.PUBLIC_USE_HASH_ROUTER === '1' ? 'hash' : 'pathname',
    },
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      // fallback: 'fallback-index.html',
      strict: true
    }),
    paths: {
      base: process.env.PUBLIC_BASE_PATH,
    },
  },
};

export default config;
