# beamer

Schaltet einen Acer-Beamer (Modell P6600, *Acer Projector Web Server C04*) über sein
Web-Interface ein und aus. Der Beamer bietet keine API — die Scripts steuern deshalb
mit [Playwright](https://playwright.dev/) einen Headless-Browser und klicken sich durch
die Oberfläche: einloggen → *Control Panel* → *Power ON* / *Power OFF*.

Geschrieben in TypeScript, das **ohne Build-Schritt** läuft: Node führt die `.ts`-Dateien
direkt aus und entfernt dabei nur die Typen.

## Voraussetzungen

- **Node.js ≥ 22.18** (oder ≥ 23.6) — ältere Versionen können TypeScript nicht nativ ausführen
- [pnpm](https://pnpm.io/)
- Netzwerkzugriff auf den Beamer (standardmäßig `http://beamer.lan`)

## Installation

```sh
pnpm install
pnpm exec playwright install chromium
```

## Konfiguration

Adresse und Passwort stehen in [`config.json`](config.json):

```json
{
  "url": "http://beamer.lan",
  "password": ""
}
```

| Feld       | Bedeutung                                                             |
| ---------- | --------------------------------------------------------------------- |
| `url`      | Basis-URL des Beamer-Webservers.                                      |
| `password` | Passwort des Benutzers *Administrator*. Leer, wenn keines gesetzt ist. |

Angemeldet wird immer als **Administrator** — das ist im Login-Formular vorausgewählt.

## Benutzung

```sh
pnpm run off    # Beamer ausschalten
pnpm run on     # Beamer einschalten
```

Mit sichtbarem Browserfenster, zum Mitschauen oder Debuggen:

```sh
pnpm run off -- --headed
pnpm run on -- --headed
```

Beide Scripts sind idempotent: Ist der Beamer bereits im gewünschten Zustand, wird
nichts geklickt und das Script endet mit einem Hinweis.

## TypeScript

Node entfernt die Typen beim Ausführen nur — es **prüft sie nicht**. Die Typprüfung läuft
deshalb separat:

```sh
pnpm run typecheck
```

Weil nur gelöscht und nicht kompiliert wird, ist ausschließlich „erasable syntax" erlaubt:
keine `enum`s, keine `namespace`s mit Laufzeitcode, keine Parameter-Properties im
Konstruktor. [`tsconfig.json`](tsconfig.json) erzwingt das über `erasableSyntaxOnly`, damit
der Fehler beim Typecheck auffällt und nicht erst zur Laufzeit.

Aus demselben Grund tragen die Imports die **explizite `.ts`-Endung**
(`import { run } from './beamer.ts'`): Node löst keine Endungen auf, sondern führt genau
die Datei aus, die dasteht.

## Gut zu wissen

**Abkühlphase.** Nach dem Ausschalten kühlt die Lampe eine Weile ab. In dieser Zeit
verwirft der Beamer eingehende Einschaltbefehle stillschweigend — der Webserver gibt
keinerlei Rückmeldung, `pnpm run on` meldet also trotzdem Erfolg, und der Status bleibt
auf `Standby`. In der Praxis hat ein zweiter Aufruf nach gut einer Minute funktioniert.

**Fehlerfall.** Schlägt ein Schritt fehl, legt das Script einen Screenshot
`beamer-error-on.png` bzw. `beamer-error-off.png` ab und endet mit Exit-Code 1.

## Aufbau

| Datei                                | Zweck                                                          |
| ------------------------------------ | -------------------------------------------------------------- |
| [`beamer.ts`](beamer.ts)             | Gemeinsame Logik: `setPower('on' \| 'off')`, Login, Navigation |
| [`beamer-on.ts`](beamer-on.ts)       | CLI-Einstiegspunkt zum Einschalten                             |
| [`beamer-off.ts`](beamer-off.ts)     | CLI-Einstiegspunkt zum Ausschalten                             |
| [`config.json`](config.json)         | URL und Passwort                                               |
| [`tsconfig.json`](tsconfig.json)     | Nur für den Typecheck — es wird nichts emittiert               |

### Einbinden als Modul

```ts
import { setPower } from './beamer.ts';

await setPower('off');
await setPower('on', { headed: true });
```

`setPower` liefert `true`, wenn tatsächlich geschaltet wurde, und `false`, wenn der
Beamer schon im gewünschten Zustand war.

## Hintergrund zur Oberfläche

Die Weboberfläche ist ein Frameset; der eigentliche Inhalt steckt im `#iframe`. Für die
Selektoren heißt das:

- Login-Formular in `home.htm`: Passwortfeld `#login_pwd`, Button `input.btn[value="Login"]`.
  Die Challenge-Response-Berechnung erledigt die Seite selbst per JavaScript.
- Erst nach erfolgreichem Login wird die Navigationsleiste `#navigator` sichtbar — das
  dient den Scripts als Login-Bestätigung.
- *Control Panel* ist `#nav_control`, der Power-Button in `control.htm` ist `#pwr`.
- `#pwr` beschriftet sich mit der Aktion, die er auslöst: steht dort „Power OFF", läuft
  der Beamer gerade. Daraus leiten die Scripts den aktuellen Zustand ab.
