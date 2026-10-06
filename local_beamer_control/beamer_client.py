"""HTTP-Client fuer den Acer Projector Web Server (P6600).

Der Beamer hat keine dokumentierte API, seine Weboberflaeche benutzt intern aber
einen schlichten Endpunkt:

    POST /tgi/control.tgi   (form-urlencoded)
        QueryControl    -> kompletter Zustand
        pwr=Power ON    -> einschalten
        pwr=Power OFF   -> ausschalten

Drei Eigenheiten, ueber die man sonst stolpert:

1. Die Antwort ist ein JS-Objektliteral mit unquotierten Keys, kein JSON -
   ``json.loads`` scheitert daran.
2. ``control.tgi`` antwortet erst dann mit Daten, wenn vorher ``/``,
   ``/home.htm`` und ``/control.htm`` abgerufen wurden. Sonst kommt HTML.
3. Fuer die Steuerung ist kein Login noetig; ``GET /`` setzt den noetigen Cookie.

Bewusst nur mit der Standardbibliothek, damit das Plugin keine Abhaengigkeiten
installieren muss.
"""

from __future__ import annotations

import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http.cookiejar import CookieJar

#: Dauer der Abkuehlphase in Sekunden.
#:
#: Gemessen am P6600 (alle 15 s ein Einschaltversuch): bei 152 s noch abgelehnt,
#: bei 171 s angenommen. Die Lampe lief in dem Test allerdings nur kurz - nach
#: langem Betrieb duerfte die Abkuehlung laenger dauern.
#:
#: Ist der Wert zu niedrig, ist das nicht schlimm: Die Taste zeigt dann zu frueh
#: "AUS", ein Druck landet in der Aufwaermphase und wird dort alle 30 s
#: wiederholt, bis der Beamer anspringt.
COOLDOWN_S = 180.0

#: Zeitfenster, in dem ein Einschaltvorgang als "laeuft noch" gilt.
WARMUP_TIMEOUT_S = 300.0

#: Netzwerk-Timeout pro Anfrage.
REQUEST_TIMEOUT_S = 8.0

# Zustaende, wie sie die Taste anzeigt.
PHASE_ON = "on"
PHASE_OFF = "off"
PHASE_COOLING = "cooling"
PHASE_WARMING = "warming"
PHASE_OFFLINE = "offline"

_LITERAL_BLOCK = re.compile(r"\{[^{}]*\}")
_LITERAL_PAIR = re.compile(r'(\w+)\s*:\s*"([^"]*)"')
_SYSSTA = re.compile(r'ID="syssta"[^>]*>([^<]*)<', re.IGNORECASE)


def parse_literal(body: str) -> dict[str, str] | None:
    """Zerlegt ein JS-Objektliteral mit unquotierten Keys.

    Gibt ``None`` zurueck, wenn der Text keines enthaelt - das passiert, wenn
    der Server statt Daten seine HTML-Seite liefert.
    """
    block = _LITERAL_BLOCK.search(body)
    if block is None:
        return None

    pairs = dict(_LITERAL_PAIR.findall(block.group(0)))
    return pairs or None


@dataclass(frozen=True)
class BeamerState:
    """Momentaufnahme des Beamers."""

    phase: str
    #: Verbleibende Abkuehlzeit in Sekunden, nur bei ``phase == PHASE_COOLING``.
    cooldown_left: int = 0
    #: Rohwert der Statusseite, z.B. "Power On" oder "Standby".
    syssta: str = ""


class BeamerClient:
    """Spricht den Beamer an und leitet daraus den Anzeigezustand ab."""

    def __init__(
        self,
        base_url: str,
        cooldown_s: float = COOLDOWN_S,
        warmup_timeout_s: float = WARMUP_TIMEOUT_S,
        timeout_s: float = REQUEST_TIMEOUT_S,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._cooldown_s = cooldown_s
        self._warmup_timeout_s = warmup_timeout_s
        self._timeout_s = timeout_s

        self._opener: urllib.request.OpenerDirector | None = None

        # Zeitpunkt, ab dem wieder eingeschaltet werden darf.
        self._cooling_until = 0.0
        # Zeitpunkt des letzten Einschaltbefehls.
        self._warming_since = 0.0
        # Letzter bekannter pwr-Wert, um Uebergaenge zu erkennen.
        self._last_pwr: str | None = None

    @property
    def base_url(self) -> str:
        return self._base_url

    def set_base_url(self, base_url: str) -> None:
        """Adresse wechseln und die Sitzung verwerfen."""
        new = base_url.rstrip("/")
        if new == self._base_url:
            return

        self._base_url = new
        self._reset_session()
        self._cooling_until = 0.0
        self._warming_since = 0.0
        self._last_pwr = None

    # -- HTTP -------------------------------------------------------------

    def _reset_session(self) -> None:
        self._opener = None

    def _open_session(self) -> urllib.request.OpenerDirector:
        """Sitzung aufbauen: Cookie holen und die Seiten "besuchen".

        Ohne diese Vorabrufe antwortet ``control.tgi`` mit HTML statt Daten.
        """
        if self._opener is not None:
            return self._opener

        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )
        for path in ("/", "/home.htm", "/control.htm"):
            opener.open(self._base_url + path, timeout=self._timeout_s).read()

        self._opener = opener
        return opener

    def send(self, command: str, attempts: int = 3) -> dict[str, str]:
        """Befehl an ``control.tgi`` schicken und den Zustand zurueckgeben.

        Verliert der Server die Sitzung, antwortet er mit HTML. Dann wird die
        Sitzung neu aufgebaut und erneut versucht.
        """
        last_body = ""
        for _ in range(attempts):
            opener = self._open_session()
            request = urllib.request.Request(
                self._base_url + "/tgi/control.tgi",
                data=command.encode("ascii"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            last_body = opener.open(request, timeout=self._timeout_s).read().decode(
                "utf-8", "replace"
            )

            state = parse_literal(last_body)
            if state is not None:
                return state

            self._reset_session()

        raise RuntimeError(f'Beamer antwortet auf "{command}" nicht mit Daten.')

    def _syssta(self) -> str:
        """Klartext-Status von der Startseite. Braucht keine Sitzung."""
        with urllib.request.urlopen(
            self._base_url + "/home.htm", timeout=self._timeout_s
        ) as response:
            html = response.read().decode("utf-8", "replace")

        match = _SYSSTA.search(html)
        return match.group(1).strip() if match else ""

    # -- Zustand ----------------------------------------------------------

    def get_state(self) -> BeamerState:
        """Aktuellen Anzeigezustand ermitteln.

        Der Beamer unterscheidet nicht zwischen "aus" und "kuehlt noch ab" -
        beides meldet er als Standby. Nachgemessen: ueber 388 s hinweg blieb
        syssta durchgehend "Standby", der Status springt schon 9 s nach dem
        Ausschaltbefehl um. Die Abkuehlphase wird deshalb aus dem beobachteten
        Uebergang an -> aus abgeleitet.

        Die Abfrage auf "cool" bleibt als Fallback stehen, falls ein anderes
        Modell doch einen eigenen Begriff meldet; beim P6600 greift sie nie.
        """
        try:
            syssta = self._syssta()
            pwr = self.send("QueryControl").get("pwr")
        except (urllib.error.URLError, OSError, RuntimeError):
            return BeamerState(PHASE_OFFLINE)

        now = time.monotonic()

        # Uebergang an -> aus: ab hier laeuft die Abkuehlphase.
        if self._last_pwr == "1" and pwr == "0":
            self._cooling_until = now + self._cooldown_s
            self._warming_since = 0.0

        if pwr == "1":
            self._warming_since = 0.0
            self._cooling_until = 0.0

        self._last_pwr = pwr

        if pwr == "1":
            return BeamerState(PHASE_ON, 0, syssta)

        # Geraeteeigene Meldung hat Vorrang vor dem geschaetzten Timer.
        if "cool" in syssta.lower():
            left = max(0, int(round(self._cooling_until - now)))
            return BeamerState(PHASE_COOLING, left, syssta)

        if now < self._cooling_until:
            return BeamerState(
                PHASE_COOLING, int(round(self._cooling_until - now)), syssta
            )

        if self._warming_since and now - self._warming_since < self._warmup_timeout_s:
            return BeamerState(PHASE_WARMING, 0, syssta)

        self._warming_since = 0.0
        return BeamerState(PHASE_OFF, 0, syssta)

    # -- Schalten ---------------------------------------------------------

    def power_on(self) -> None:
        """Einschalten. Waehrend der Abkuehlphase verwirft der Beamer das."""
        self._warming_since = time.monotonic()
        self.send("pwr=Power ON")

    def power_off(self) -> None:
        """Ausschalten. Startet die Abkuehlphase."""
        self._cooling_until = time.monotonic() + self._cooldown_s
        self._warming_since = 0.0
        self.send("pwr=Power OFF")

    def retry_power_on(self) -> None:
        """Nachfassen, ohne den Aufwaerm-Zeitstempel zu verlieren."""
        self.send("pwr=Power ON")
