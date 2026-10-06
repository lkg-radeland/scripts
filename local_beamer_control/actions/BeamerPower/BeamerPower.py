"""Taste: schaltet den Beamer und zeigt seinen Zustand an."""

from __future__ import annotations

import os
import threading
import time

# StreamController-Module
from src.backend.PluginManager.ActionBase import ActionBase

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, GLib, Gtk  # noqa: E402

from ...beamer_client import (  # noqa: E402
    PHASE_COOLING,
    PHASE_OFF,
    PHASE_OFFLINE,
    PHASE_ON,
    PHASE_WARMING,
    BeamerClient,
    BeamerState,
)

DEFAULT_URL = "http://beamer.lan"
DEFAULT_POLL_SECONDS = 5

#: Waehrend des Aufwaermens nachfassen - der Beamer verwirft fruehe Befehle.
RESEND_INTERVAL_S = 30.0

#: Beschriftung je Zustand: (Mitte, Unten)
LABELS = {
    PHASE_ON: ("AN", ""),
    PHASE_OFF: ("AUS", ""),
    PHASE_COOLING: ("Kühlt ab", ""),  # unten steht der Countdown
    PHASE_WARMING: ("Startet", "…"),
    PHASE_OFFLINE: ("offline", ""),
}


class BeamerPower(ActionBase):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self._client: BeamerClient | None = None
        self._client_lock = threading.Lock()

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_resend = 0.0

    # -- Lebenszyklus -----------------------------------------------------

    def on_ready(self) -> None:
        self._apply_state(BeamerState(PHASE_OFFLINE))
        self._start_polling()

    def on_remove(self) -> None:
        self._stop_polling()

    def on_removed_from_cache(self) -> None:
        self._stop_polling()

    # -- Einstellungen ----------------------------------------------------

    def _url(self) -> str:
        return (self.get_settings().get("url") or DEFAULT_URL).strip() or DEFAULT_URL

    def _poll_seconds(self) -> int:
        try:
            value = int(self.get_settings().get("poll_seconds", DEFAULT_POLL_SECONDS))
        except (TypeError, ValueError):
            value = DEFAULT_POLL_SECONDS
        return max(2, value)

    def _get_client(self) -> BeamerClient:
        """Client holen; bei geaenderter Adresse umstellen."""
        url = self._url()
        if self._client is None:
            self._client = BeamerClient(url)
        else:
            self._client.set_base_url(url)
        return self._client

    def get_config_rows(self) -> list:
        settings = self.get_settings()

        url_row = Adw.EntryRow(title="Adresse")
        url_row.set_text(settings.get("url") or DEFAULT_URL)
        url_row.connect("notify::text", self._on_url_changed)

        poll_row = Adw.SpinRow.new_with_range(2, 60, 1)
        poll_row.set_title("Abfrage (Sekunden)")
        poll_row.set_value(self._poll_seconds())
        poll_row.connect("notify::value", self._on_poll_changed)

        return [url_row, poll_row]

    def _on_url_changed(self, row: Adw.EntryRow, *_args) -> None:
        settings = self.get_settings()
        settings["url"] = row.get_text()
        self.set_settings(settings)
        # Adresse geaendert: Sitzung verwerfen und sofort neu abfragen.
        self._restart_polling()

    def _on_poll_changed(self, row: Adw.SpinRow, *_args) -> None:
        settings = self.get_settings()
        settings["poll_seconds"] = int(row.get_value())
        self.set_settings(settings)
        self._restart_polling()

    # -- Tastendruck ------------------------------------------------------

    def on_key_down(self) -> None:
        # Netzwerk nie im UI-Thread: sonst friert StreamController ein.
        threading.Thread(target=self._handle_key_down, daemon=True).start()

    def _handle_key_down(self) -> None:
        try:
            with self._client_lock:
                client = self._get_client()
                state = client.get_state()

                if state.phase == PHASE_ON:
                    client.power_off()
                elif state.phase == PHASE_OFF:
                    client.power_on()
                elif state.phase == PHASE_WARMING:
                    # Laeuft schon - ein Druck fasst nach.
                    client.retry_power_on()
                else:
                    # Abkuehlphase oder offline: Einschalten waere wirkungslos.
                    GLib.idle_add(self.show_error, 2)
                    return
        except Exception:
            GLib.idle_add(self.show_error, 2)
            return

        self._poll_once()

    # -- Abfrage ----------------------------------------------------------

    def _start_polling(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def _stop_polling(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=1.0)
        self._thread = None

    def _restart_polling(self) -> None:
        self._stop_polling()
        self._start_polling()

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            self._poll_once()
            self._stop.wait(self._poll_seconds())

    def _poll_once(self) -> None:
        try:
            with self._client_lock:
                client = self._get_client()
                state = client.get_state()

                # Beim Aufwaermen verwirft der Beamer Befehle - nachfassen.
                now = time.monotonic()
                if (
                    state.phase == PHASE_WARMING
                    and now - self._last_resend > RESEND_INTERVAL_S
                ):
                    self._last_resend = now
                    try:
                        client.retry_power_on()
                    except Exception:
                        pass
        except Exception:
            state = BeamerState(PHASE_OFFLINE)

        GLib.idle_add(self._apply_state, state)

    # -- Anzeige ----------------------------------------------------------

    def _apply_state(self, state: BeamerState) -> bool:
        """Beschriftung und Bild setzen. Laeuft im UI-Thread."""
        center, bottom = LABELS.get(state.phase, ("?", ""))

        if state.phase == PHASE_COOLING:
            bottom = f"{state.cooldown_left // 60}:{state.cooldown_left % 60:02d}"

        self.set_top_label("Beamer")
        self.set_center_label(center)
        self.set_bottom_label(bottom)

        icon = "beamer-on.png" if state.phase == PHASE_ON else "beamer-off.png"
        self.set_media(
            media_path=os.path.join(self.plugin_base.PATH, "assets", icon), size=0.8
        )

        # idle_add nicht wiederholen.
        return False
