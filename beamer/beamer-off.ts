// Schaltet den Acer-Beamer aus.
//   pnpm run off            (headless)
//   pnpm run off -- --headed
import { run } from './beamer.ts';

run('off');
