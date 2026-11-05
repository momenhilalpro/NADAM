import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: './',
    plugins: [{
      name: 'inject-public-store-config',
      transformIndexHtml(html) {
      const geminiKey = env.VITE_GEMINI_API_KEY || '';
      const escapedKey = geminiKey
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return html.replace(
        '</head>',
        `    <meta name="gemini-api-key" content="${escapedKey}">\n</head>`
      );
      }
    }]
  };
});
