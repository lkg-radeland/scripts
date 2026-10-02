# beamer

Schaltet einen Acer-Beamer (Modell P6600, *Acer Projector Web Server C04*) über sein
Web-Interface ein und aus. Der Beamer bietet keine API — die Scripts steuern deshalb
mit [Playwright](https://playwright.dev/) einen Headless-Browser und klicken sich durch
die Oberfläche: einloggen → *Control Panel* → *Power ON* / *Power OFF*.

## Voraussetzungen

- Node.js 22+
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

| Feld       | Bedeutung                                                                 |
| ---------- | ------------------------------------------------------------------------- |
| `url`      | Basis-URL des Beamer-Webservers.                                          |
| `password` | Passwort des Benutzers *Administrator*. Leer, wenn keines gesetzt ist.     |

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

## Gut zu wissen

**Abkühlphase.** Nach dem Ausschalten kühlt die Lampe eine Weile ab. In dieser Zeit
verwirft der Beamer eingehende Einschaltbefehle stillschweigend — der Webserver gibt
keinerlei Rückmeldung, `pnpm run on` meldet also trotzdem Erfolg, und der Status bleibt
auf `Standby`. In der Praxis hat ein zweiter Aufruf nach gut einer Minute funktioniert.

**Fehlerfall.** Schlägt ein Schritt fehl, legt das Script einen Screenshot
`beamer-error-on.png` bzw. `beamer-error-off.png` ab und endet mit Exit-Code 1.

## Aufbau

| Datei                                | Zweck                                                        |
| ------------------------------------ | ------------------------------------------------------------ |
| [`beamer.js`](beamer.js)             | Gemeinsame Logik: `setPower('on' \| 'off')`, Login, Navigation |
| [`beamer-on.js`](beamer-on.js)       | CLI-Einstiegspunkt zum Einschalten                           |
| [`beamer-off.js`](beamer-off.js)     | CLI-Einstiegspunkt zum Ausschalten                           |
| [`config.json`](config.json)         | URL und Passwort                                             |

### Einbinden als Modul

```js
const { setPower } = require('./beamer');

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
- `#pwr` beschriftet sich mit der Aktion, die er auslöst: steht dort „Power OFF“, läuft
  der Beamer gerade. Daraus leiten die Scripts den aktuellen Zustand ab.
