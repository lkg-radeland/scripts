# beamer

Schaltet einen Acer-Beamer (Modell P6600, *Acer Projector Web Server C04*) über das
Netzwerk ein und aus und liest seinen Status.

Der Beamer hat zwar keine dokumentierte API, seine Weboberfläche benutzt intern aber
einen schlichten HTTP-Endpunkt. Den sprechen die Scripts direkt an — **ohne Browser**.
Ein Schaltvorgang ist damit ein einzelner POST statt eines Chromium-Starts, und das
Ergebnis lässt sich verifizieren statt nur abzuschicken.

Die alte, browsergesteuerte Variante über [Playwright](https://playwright.dev/) liegt als
Fallback daneben (`--playwright`).

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
pnpm run off      # Beamer ausschalten
pnpm run on       # Beamer einschalten
pnpm run status   # Status anzeigen
```

`on` und `off` sind idempotent: Ist der Beamer bereits im gewünschten Zustand, passiert
nichts. Danach wird so lange gepollt, bis der Beamer den neuen Zustand **tatsächlich
meldet** — das Script lügt dich also nicht an, wenn ein Befehl verschluckt wurde.

`status` braucht weder Session noch Passwort und liefert als einziger Aufruf
Lampenstunden und Fehlerstatus:

```
Modell         P6600
Status         Power On
Quelle         HDBaseT
Lampenstunden  1353
Bildmodus      Presentation
Fehler         Normal
```

### Fallback über den Browser

```sh
pnpm run off -- --playwright
pnpm run on -- --playwright --headed
```

Steuert wie früher die Weboberfläche per Headless-Browser. Langsamer und ohne
Verifikation, aber nützlich, falls der HTTP-Endpunkt sich anders verhält als erwartet.
`--headed` zeigt dabei das Browserfenster.

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

**Abkühlphase.** Nach dem Ausschalten kühlt die Lampe ab. In dieser Zeit verwirft der
Beamer Einschaltbefehle **stillschweigend** — er antwortet normal, tut aber nichts. Genau
deshalb pollt `setPower` den Zustand und fasst alle 30 Sekunden nach, statt einmal blind
zu senden.

Gemessen: Ausschalten greift sofort (~14 s, davon fast alles Verifikation), Einschalten
aus der Abkühlphase heraus brauchte **156 s und vier Nachfass-Versuche**. Der Default-
Timeout liegt deshalb bei 300 s.

**Standby liefert teils Platzhalter.** Im Standby kann `status` für Lampenstunden und
Bildmodus `0` und als Quelle `No Signal` zurückgeben statt der echten Werte. Verlässlich
ist dort nur `Status` selbst.

**Wackelige Sessions.** Der Server verliert gelegentlich die Session und antwortet dann
mit HTML statt mit Daten. `send()` baut die Session in dem Fall neu auf und versucht es
erneut (dreimal), statt den Aufruf scheitern zu lassen.

## Das HTTP-Protokoll

Alles läuft über `POST /tgi/control.tgi`, form-urlencoded:

| Body                            | Wirkung                            |
| ------------------------------- | ---------------------------------- |
| `QueryControl`                  | kompletter Zustand                 |
| `pwr=Power ON` / `pwr=Power OFF`| ein-/ausschalten                   |
| `hid=Hide ON`, `frz=Freeze`, …  | weitere Buttons, gleiches Muster   |
| `src=<index>`, `mod=<index>`    | Auswahlfelder (Index statt Wert)   |

Die Antwort ist immer der vollständige Zustand, `pwr` ist `"1"` für an und `"0"` für aus:

```
{pwr:"0",hid:"0",frz:"0",eco:"1",src:"23",bri:"48",con:"52",…,M:"3"}
```

Drei Eigenheiten, über die man sonst stolpert:

- **Das ist kein gültiges JSON.** Die Keys sind unquotiert, weil die Oberfläche die
  Antwort durch `eval` jagt. `JSON.parse` scheitert — `parseLiteral()` zerlegt es deshalb
  selbst.
- **Die Reihenfolge zählt.** `control.tgi` antwortet erst mit Daten, wenn vorher `GET /`,
  `/home.htm` und `/control.htm` abgerufen wurden. Sonst kommt kommentarlos HTML zurück.
  Das erledigt `BeamerSession.open()`.
- **Der Login ist für die Steuerung nicht nötig.** `GET /` setzt einen Cookie (`ATOP=…`),
  und damit funktioniert `control.tgi` bereits. Getestet wurde das allerdings nur *ohne*
  gesetztes Passwort — ob der Endpunkt grundsätzlich ungeschützt ist oder das leere
  Passwort jeden durchwinkt, ist offen. Für den Fall, dass ein Passwort gesetzt wird,
  beherrscht `open()` den Login trotzdem.

Der Login selbst: `POST /tgi/login.tgi` mit `Username=1&Response=<md5>`, wobei
`md5 = MD5("admin" + Passwort + Challenge)` ist und die Challenge als Hidden-Field in
`home.htm` steht (`"guest"` statt `"admin"` bei `Username=2`).

Für den Status reicht ein nackter `GET /home.htm` — ganz ohne Session.

## Aufbau

| Datei                                  | Zweck                                                       |
| -------------------------------------- | ----------------------------------------------------------- |
| [`beamer-api.ts`](beamer-api.ts)       | HTTP-Steuerung: `setPower`, `getStatus`, `BeamerSession`     |
| [`beamer.ts`](beamer.ts)               | Playwright-Fallback über die Weboberfläche                   |
| [`beamer-on.ts`](beamer-on.ts)         | CLI zum Einschalten                                          |
| [`beamer-off.ts`](beamer-off.ts)       | CLI zum Ausschalten                                          |
| [`beamer-status.ts`](beamer-status.ts) | CLI für den Status                                           |
| [`config.json`](config.json)           | URL und Passwort                                             |
| [`tsconfig.json`](tsconfig.json)       | Nur für den Typecheck — es wird nichts emittiert             |

### Einbinden als Modul

```ts
import { setPower, getStatus, BeamerSession } from './beamer-api.ts';

await setPower('off');
await setPower('on', { timeoutMs: 300000, verbose: false });

const { syssta, lamphr } = await getStatus();

// Für alles jenseits von Power:
const session = new BeamerSession();
await session.send('frz=Freeze');
const state = await session.query();
```

`setPower` liefert `true`, wenn geschaltet wurde, `false`, wenn der Zustand schon passte,
und wirft, wenn der Beamer innerhalb des Timeouts nicht umschaltet.

## Hintergrund zur Weboberfläche

Relevant nur noch für den `--playwright`-Fallback. Die Oberfläche ist ein Frameset, der
Inhalt steckt im `#iframe`:

- Login-Formular in `home.htm`: Passwortfeld `#login_pwd`, Button `input.btn[value="Login"]`.
- Erst nach erfolgreichem Login wird die Navigationsleiste `#navigator` sichtbar — das
  dient als Login-Bestätigung.
- *Control Panel* ist `#nav_control`, der Power-Button in `control.htm` ist `#pwr`.
- `#pwr` beschriftet sich mit der Aktion, die er auslöst: steht dort „Power OFF", läuft
  der Beamer gerade.

Im Fehlerfall legt der Fallback einen Screenshot `beamer-error-on.png` bzw.
`beamer-error-off.png` ab.
