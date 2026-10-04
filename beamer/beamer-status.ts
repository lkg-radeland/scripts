// Zeigt den Status des Beamers.
//   pnpm run status
// Braucht weder Session noch Passwort.
import { getStatus } from './beamer-api.ts';

const labels: Record<string, string> = {
  model: 'Modell',
  syssta: 'Status',
  dissrc: 'Quelle',
  lamphr: 'Lampenstunden',
  dismod: 'Bildmodus',
  errsta: 'Fehler',
};

try {
  const status = await getStatus();
  for (const [key, label] of Object.entries(labels)) {
    console.log(`${label.padEnd(14)} ${status[key as keyof typeof status]}`);
  }
} catch (err) {
  console.error('Fehler:', err instanceof Error ? err.message : err);
  process.exit(1);
}
