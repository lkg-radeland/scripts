# Stream-Deck-Plugin: Beamer

Eine Taste, die einen Acer-Beamer (P6600) über das Netzwerk schaltet und dabei **anzeigt,
was gerade los ist** — inklusive der Abkühlphase, in der der Beamer keine
Einschaltbefehle annimmt.

Steuert den Beamer direkt über dessen HTTP-Endpunkt, ohne Browser. Das Protokoll ist in
der [README des Schwesterprojekts](../beamer/README.md) dokumentiert.

## Was die Taste anzeigt

| Zustand | Beschriftung | Tastendruck bewirkt |
| --- | --- | --- |
| Beamer läuft | `Beamer` / `AN` | schaltet aus |
| Aus und bereit | `Beamer` / `AUS` | schaltet ein |
| Lampe kühlt noch ab | `Kühlt ab` / `1:47` (Countdown) | nichts, zeigt eine Warnung |
| Einschalten läuft | `Startet` / `…` | fasst sofort nach |
| Nicht erreichbar | `Beamer` / `offline` | zeigt eine Warnung |

Das Tastenbild wechselt zusätzlich zwischen dunklem und leuchtendem Projektor.

## Warum die Abkühlphase eine eigene Anzeige braucht

Nach dem Ausschalten kühlt die Lampe ab. In dieser Zeit **verwirft der Beamer
Einschaltbefehle kommentarlos** — er antwortet ganz normal, tut aber nichts. Ohne
Rückmeldung drückt man also auf eine Taste, die scheinbar funktioniert, und nichts
passiert.

Erschwerend: Der Beamer selbst unterscheidet nicht zwischen „aus" und „kühlt noch ab", er
meldet beides als `Standby`. Das Plugin leitet die Abkühlphase deshalb aus dem
beobachteten Übergang *an → aus* ab und zeigt einen Countdown. Gemessen wurden **156
Sekunden**, bis ein Einschaltbefehl wieder angenommen wurde; der Timer läuft mit 180
Sekunden.

Sollte ein Gerät doch einen eigenen Begriff melden (etwa `Cooling`), hat der Vorrang vor
dem geschätzten Timer — die Logik prüft das zuerst.

Beim Einschalten fasst das Plugin alle 30 Sekunden nach, bis der Beamer tatsächlich `an`
meldet.

## Voraussetzungen

- **Stream Deck 7.1 oder neuer** (das Plugin deklariert Node 24 als Laufzeit)
- Node.js ≥ 20.5 zum Bauen
- pnpm

Läuft deine Stream-Deck-Software noch auf 6.x, in [`manifest.json`](local.beamer.control.sdPlugin/manifest.json)
`Nodejs.Version` auf `"20"` und `Software.MinimumVersion` auf `"6.6"` setzen.

## Installation

```sh
pnpm install
pnpm run build
pnpm run link      # verknüpft den Plugin-Ordner mit Stream Deck
pnpm run restart
```

`link` und `restart` brauchen die Elgato-CLI:

```sh
pnpm add -g @elgato/cli
```

Während der Entwicklung baut `pnpm run watch` bei jeder Änderung neu und startet das
Plugin durch.

## Konfiguration

Pro Taste im Property Inspector einstellbar:

| Feld | Default | Bedeutung |
| --- | --- | --- |
| Adresse | `http://beamer.lan` | Basis-URL des Beamers |
| Abfrage | 5 s | wie oft der Zustand geprüft wird |

## Tests

```sh
pnpm test        # Zustandsautomat gegen einen simulierten Beamer
pnpm run typecheck
```

Die Tests starten einen lokalen HTTP-Server, der den Beamer nachbildet — **einschließlich
des Verhaltens, Einschaltbefehle während der Abkühlphase stillschweigend zu verwerfen**.
Damit sind die fünf Zustände und die Übergänge abgedeckt, ohne echte Hardware.

## Aufbau

| Pfad | Zweck |
| --- | --- |
| [`src/beamer-client.ts`](src/beamer-client.ts) | HTTP-Protokoll und Zustandsermittlung |
| [`src/actions/beamer-power.ts`](src/actions/beamer-power.ts) | Die Taste: Polling, Beschriftung, Tastendruck |
| [`src/plugin.ts`](src/plugin.ts) | Einstiegspunkt |
| [`test/phases.test.ts`](test/phases.test.ts) | Zustandsautomat gegen simulierten Beamer |
| `local.beamer.control.sdPlugin/` | Das fertige Plugin (Manifest, Bundle, Bilder, UI) |

Der Code wird mit Rollup gebündelt, weil Stream Deck das Plugin mit seinem eigenen Node
startet und dort keine `.ts`-Dateien direkt ausgeführt werden können. Das unterscheidet
dieses Projekt vom Schwesterprojekt [`../beamer`](../beamer), das ohne Build-Schritt läuft.

Der Protokoll-Client ist bewusst eine eigenständige Fassung und kein Import aus
`../beamer`: Dort kommt die Konfiguration aus einer `config.json`, hier aus den
Stream-Deck-Einstellungen.
