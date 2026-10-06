# StreamController-Plugin: Beamer

Eine Taste, die einen Acer-Beamer (P6600) über das Netzwerk schaltet und dabei **anzeigt,
was gerade los ist** — einschließlich der Abkühlphase, in der der Beamer keine
Einschaltbefehle annimmt.

Steuert den Beamer direkt über dessen HTTP-Endpunkt. Das Protokoll ist in der
[README des Schwesterprojekts](../beamer/README.md) ausführlich dokumentiert.

## Was die Taste anzeigt

Die Beschriftung ist dreizeilig: oben immer `Beamer`, in der Mitte der Zustand, unten
Zusatzinfo.

| Zustand | Mitte | Unten | Tastendruck bewirkt |
| --- | --- | --- | --- |
| Beamer läuft | `AN` | | schaltet aus |
| Aus und bereit | `AUS` | | schaltet ein |
| Lampe kühlt ab | `Kühlt ab` | `1:47` (Countdown) | nichts, zeigt Fehlerblinken |
| Einschalten läuft | `Startet` | `…` | fasst sofort nach |
| Nicht erreichbar | `offline` | | zeigt Fehlerblinken |

Zusätzlich wechselt das Tastenbild zwischen dunklem und leuchtendem Projektor.

## Warum die Abkühlphase eine eigene Anzeige braucht

Nach dem Ausschalten kühlt die Lampe ab. In dieser Zeit **verwirft der Beamer
Einschaltbefehle kommentarlos** — er antwortet ganz normal, tut aber nichts. Ohne
Rückmeldung drückt man also auf eine Taste, die zu funktionieren scheint, und nichts
passiert.

Erschwerend kommt hinzu: Der Beamer unterscheidet selbst nicht zwischen „aus" und „kühlt
noch ab" — beides meldet er als `Standby`. Das Plugin leitet die Abkühlphase deshalb aus
dem beobachteten Übergang *an → aus* ab und zeigt einen Countdown. Gemessen wurden **156
Sekunden**, bis ein Einschaltbefehl wieder angenommen wurde; der Timer läuft mit 180.

Sollte ein Gerät doch einen eigenen Begriff melden (etwa `Cooling`), hat der Vorrang vor
dem geschätzten Timer — die Logik prüft das zuerst.

Beim Einschalten fasst das Plugin alle 30 Sekunden nach, bis der Beamer tatsächlich `an`
meldet.

## Installation

Das Plugin ist nicht im Store; es wird direkt in den Plugin-Ordner gelegt. **Der
Ordnername muss `local_beamer_control` bleiben** — Python kann Pakete mit Bindestrichen
oder Punkten im Namen nicht importieren.

```sh
cp -r local_beamer_control ~/.var/app/com.core447.StreamController/data/plugins/
```

Bei einer Nicht-Flatpak-Installation stattdessen nach
`~/.local/share/StreamController/plugins/`. Danach StreamController neu starten und die
Action *Beamer Power* auf eine Taste ziehen.

## Voraussetzungen

- StreamController **1.5.0-beta.7** (gegen diese API gebaut)
- Python ≥ 3.10 (für die `X | None`-Schreibweise; getestet mit 3.14)
- Keine zusätzlichen Pakete — der Client nutzt nur die Standardbibliothek

## Konfiguration

Pro Taste einstellbar:

| Feld | Default | Bedeutung |
| --- | --- | --- |
| Adresse | `http://beamer.lan` | Basis-URL des Beamers |
| Abfrage | 5 s | wie oft der Zustand geprüft wird |

## Tests

```sh
python -m unittest discover -s tests
```

Die Tests starten einen lokalen HTTP-Server, der den Beamer nachbildet — **einschließlich
des Verhaltens, Einschaltbefehle während der Abkühlphase stillschweigend zu verwerfen**.
Damit sind alle fünf Zustände, die Übergänge und das Zerlegen der Antwort abgedeckt, ohne
echte Hardware.

## Aufbau

| Pfad | Zweck |
| --- | --- |
| [`beamer_client.py`](beamer_client.py) | HTTP-Protokoll und Zustandsermittlung, stdlib-only |
| [`actions/BeamerPower/BeamerPower.py`](actions/BeamerPower/BeamerPower.py) | Die Taste: Polling, Beschriftung, Tastendruck |
| [`main.py`](main.py) | Plugin-Registrierung |
| [`tests/test_phases.py`](tests/test_phases.py) | Zustandsautomat gegen simulierten Beamer |
| `assets/` | Tastenbilder |

### Nebenläufigkeit

Netzwerkaufrufe laufen grundsätzlich in einem Hintergrund-Thread; ein blockierender
HTTP-Aufruf im UI-Thread würde StreamController einfrieren lassen. Die Anzeige wird
anschließend über `GLib.idle_add` im Hauptthread aktualisiert, weil GTK nur von dort
angefasst werden darf. Ein Lock verhindert, dass Tastendruck und Abfrage gleichzeitig auf
den Client zugreifen.
