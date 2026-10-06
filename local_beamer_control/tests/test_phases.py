"""Prueft den Zustandsautomaten gegen einen simulierten Beamer.

Simuliert wird auch das entscheidende Verhalten des echten Geraets: Waehrend der
Abkuehlphase nimmt es Einschaltbefehle entgegen, ignoriert sie aber.

    python -m unittest discover -s tests
"""

from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from beamer_client import (  # noqa: E402
    PHASE_COOLING,
    PHASE_OFF,
    PHASE_OFFLINE,
    PHASE_ON,
    PHASE_WARMING,
    BeamerClient,
    parse_literal,
)


class FakeProjector:
    """Bildet die Eigenheiten des Acer-Webservers nach."""

    def __init__(self) -> None:
        self.pwr = "1"
        self.syssta = "Power On"
        #: Vor diesem Zeitpunkt werden Einschaltbefehle verworfen.
        self.accept_on_after = 0.0

        projector = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):  # Testausgabe ruhig halten
                pass

            def _send(self, body: str) -> None:
                payload = body.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Set-Cookie", "ATOP=test")
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):  # noqa: N802
                self._send(f'<html><td ID="syssta">{projector.syssta}</td></html>')

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(length).decode("ascii")

                if body == "pwr=Power ON" and time.monotonic() >= projector.accept_on_after:
                    projector.pwr = "1"
                    projector.syssta = "Power On"
                elif body == "pwr=Power OFF":
                    projector.pwr = "0"
                    projector.syssta = "Standby"

                self._send(f'{{pwr:"{projector.pwr}",hid:"0",frz:"0",M:"3"}}')

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"


class ParseLiteralTest(unittest.TestCase):
    def test_zerlegt_unquotierte_keys(self):
        body = '{pwr:"1",hid:"0",M:"3"}'
        self.assertEqual(parse_literal(body), {"pwr": "1", "hid": "0", "M": "3"})

    def test_gibt_none_bei_html(self):
        self.assertIsNone(parse_literal("<html><body>nix</body></html>"))


class PhasesTest(unittest.TestCase):
    projector: FakeProjector

    @classmethod
    def setUpClass(cls):
        cls.projector = FakeProjector()
        cls.projector.start()

    @classmethod
    def tearDownClass(cls):
        cls.projector.stop()

    def test_on(self):
        self.projector.pwr = "1"
        self.projector.syssta = "Power On"
        client = BeamerClient(self.projector.url)

        self.assertEqual(client.get_state().phase, PHASE_ON)

    def test_cooling_nach_ausschalten(self):
        self.projector.pwr = "1"
        self.projector.syssta = "Power On"
        client = BeamerClient(self.projector.url, cooldown_s=1.5)
        client.get_state()  # Ausgangszustand lernen

        client.power_off()
        state = client.get_state()

        self.assertEqual(state.phase, PHASE_COOLING)
        self.assertGreater(state.cooldown_left, 0)

    def test_off_nach_ablauf_der_abkuehlphase(self):
        self.projector.pwr = "1"
        self.projector.syssta = "Power On"
        client = BeamerClient(self.projector.url, cooldown_s=0.3)
        client.get_state()

        client.power_off()
        self.assertEqual(client.get_state().phase, PHASE_COOLING)

        time.sleep(0.4)
        self.assertEqual(client.get_state().phase, PHASE_OFF)

    def test_warming_solange_befehl_verworfen_wird(self):
        self.projector.pwr = "0"
        self.projector.syssta = "Standby"
        self.projector.accept_on_after = time.monotonic() + 0.6
        client = BeamerClient(self.projector.url, cooldown_s=0.05)

        time.sleep(0.06)
        client.power_on()
        self.assertEqual(client.get_state().phase, PHASE_WARMING)

        time.sleep(0.6)
        client.retry_power_on()
        self.assertEqual(client.get_state().phase, PHASE_ON)

    def test_geraeteeigene_cooling_meldung_hat_vorrang(self):
        self.projector.pwr = "0"
        self.projector.syssta = "Cooling Down"
        client = BeamerClient(self.projector.url, cooldown_s=0.001)

        self.assertEqual(client.get_state().phase, PHASE_COOLING)

    def test_offline(self):
        client = BeamerClient("http://127.0.0.1:1", timeout_s=0.5)
        self.assertEqual(client.get_state().phase, PHASE_OFFLINE)


if __name__ == "__main__":
    unittest.main()
