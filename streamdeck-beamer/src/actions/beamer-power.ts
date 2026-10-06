import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { BeamerClient, type BeamerState, type PowerPhase } from "../beamer-client";

/**
 * Die Index-Signatur ist noetig, damit der Typ die JsonObject-Bedingung von
 * SingletonAction erfuellt. JsonObject selbst liegt in @elgato/utils und ist
 * unter pnpm nicht direkt importierbar.
 */
export type BeamerSettings = {
	/** Basis-URL des Beamers, z.B. http://beamer.lan */
	url?: string;
	/** Abfrageintervall in Sekunden. */
	pollSeconds?: number;
	[key: string]: string | number | undefined;
};

const DEFAULT_URL = "http://beamer.lan";
const DEFAULT_POLL_SECONDS = 5;

/** Waehrend des Aufwaermens alle 30 s nachfassen - der Beamer verwirft fruehe Befehle. */
const RESEND_INTERVAL_MS = 30_000;

/** Beschriftung je Zustand. \n trennt die Zeilen auf der Taste. */
function titleFor(state: BeamerState): string {
	switch (state.phase) {
		case "on":
			return "Beamer\nAN";
		case "off":
			return "Beamer\nAUS";
		case "cooling": {
			const s = state.cooldownLeft;
			const mmss = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
			return `Kühlt ab\n${mmss}`;
		}
		case "warming":
			return "Startet\n…";
		case "offline":
			return "Beamer\noffline";
	}
}

/** Bildzustand: 1 = an, 0 = alles andere. */
function imageStateFor(phase: PowerPhase): number {
	return phase === "on" ? 1 : 0;
}

@action({ UUID: "local.beamer.control.power" })
export class BeamerPowerAction extends SingletonAction<BeamerSettings> {
	#client: BeamerClient | null = null;
	#timer: NodeJS.Timeout | null = null;
	#lastResend = 0;
	/** Verhindert, dass sich Abfrage und Tastendruck ueberlappen. */
	#busy = false;

	#clientFor(settings: BeamerSettings): BeamerClient {
		const url = settings.url?.trim() || DEFAULT_URL;
		if (!this.#client) {
			this.#client = new BeamerClient(url);
		} else {
			this.#client.setBaseUrl(url);
		}

		return this.#client;
	}

	override async onWillAppear(ev: WillAppearEvent<BeamerSettings>): Promise<void> {
		this.#clientFor(await ev.action.getSettings());
		this.#startPolling(ev.payload.settings);
		await this.#refresh();
	}

	override onWillDisappear(_ev: WillDisappearEvent<BeamerSettings>): void {
		// Erst stoppen, wenn keine Kachel dieser Action mehr sichtbar ist.
		if ([...this.actions].length <= 1) {
			this.#stopPolling();
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<BeamerSettings>): Promise<void> {
		this.#clientFor(ev.payload.settings);
		this.#startPolling(ev.payload.settings);
		await this.#refresh();
	}

	override async onKeyDown(ev: KeyDownEvent<BeamerSettings>): Promise<void> {
		if (this.#busy) {
			return;
		}

		const client = this.#clientFor(ev.payload.settings);
		this.#busy = true;

		try {
			const state = await client.getState();

			switch (state.phase) {
				case "on":
					await client.powerOff();
					break;

				case "off":
					await client.powerOn();
					break;

				case "cooling":
					// Jetzt einzuschalten waere wirkungslos - der Beamer verwirft es.
					await ev.action.showAlert();
					break;

				case "warming":
					// Laeuft schon; ein weiterer Druck faellt auf ein Nachfassen zurueck.
					await client.retryPowerOn();
					break;

				case "offline":
					await ev.action.showAlert();
					break;
			}
		} catch (err) {
			streamDeck.logger.error("Schalten fehlgeschlagen", err);
			await ev.action.showAlert();
		} finally {
			this.#busy = false;
		}

		await this.#refresh();
	}

	#startPolling(settings: BeamerSettings): void {
		this.#stopPolling();
		const seconds = Math.max(2, settings.pollSeconds ?? DEFAULT_POLL_SECONDS);
		this.#timer = setInterval(() => void this.#refresh(), seconds * 1000);
	}

	#stopPolling(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	/** Zustand abfragen und alle sichtbaren Kacheln aktualisieren. */
	async #refresh(): Promise<void> {
		const client = this.#client;
		if (!client || this.#busy) {
			return;
		}

		let state: BeamerState;
		try {
			state = await client.getState();
		} catch (err) {
			streamDeck.logger.error("Statusabfrage fehlgeschlagen", err);
			state = { phase: "offline", cooldownLeft: 0, syssta: "" };
		}

		// Beim Aufwaermen verwirft der Beamer Befehle - also regelmaessig nachfassen.
		if (state.phase === "warming" && Date.now() - this.#lastResend > RESEND_INTERVAL_MS) {
			this.#lastResend = Date.now();
			try {
				await client.retryPowerOn();
			} catch (err) {
				streamDeck.logger.warn("Nachfassen fehlgeschlagen", err);
			}
		}

		const title = titleFor(state);
		const imageState = imageStateFor(state.phase);

		// Nur Tasten koennen Titel und Bildzustand anzeigen.
		for (const action of this.actions) {
			if (!action.isKey()) {
				continue;
			}

			await action.setTitle(title);
			await action.setState(imageState);
		}
	}
}
