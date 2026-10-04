// Schaltet den Acer-Beamer ein.
//   pnpm run on                (ueber den HTTP-Endpunkt, schnell)
//   pnpm run on -- --playwright   (ueber die Weboberflaeche, als Fallback)
const mod = process.argv.includes('--playwright')
  ? await import('./beamer.ts')
  : await import('./beamer-api.ts');

mod.run('on');
