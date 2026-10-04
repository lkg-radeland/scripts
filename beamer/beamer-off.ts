// Schaltet den Acer-Beamer aus.
//   pnpm run off                (ueber den HTTP-Endpunkt, schnell)
//   pnpm run off -- --playwright   (ueber die Weboberflaeche, als Fallback)
const mod = process.argv.includes('--playwright')
  ? await import('./beamer.ts')
  : await import('./beamer-api.ts');

mod.run('off');
