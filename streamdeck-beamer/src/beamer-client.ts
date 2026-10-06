/**
 * HTTP-Client fuer den Acer Projector Web Server.
 *
 * Eigenstaendige Fassung fuer das Plugin: Die Konfiguration kommt hier aus den
 * Stream-Deck-Einstellungen statt aus einer config.json, und der Code wird
 * gebuendelt statt direkt ausgefuehrt.
 *
 * Protokoll (form-urlencoded an POST /tgi/control.tgi):
 *   QueryControl   -> kompletter Zustand als JS-Objektliteral (kein JSON!)
 *   pwr=Power ON   -> einschalten
 *   pwr=Power OFF  -> ausschalten
 */

/** Zustand, wie ihn die Kachel anzeigt. */
export type PowerPhase =
	/** Laeuft. */
	| "on"
	/** Aus und bereit zum Einschalten. */
	| "off"
	/** Aus, aber die Lampe kuehlt noch - Einschaltbefehle werden verworfen. */
	| "cooling"
	/** Einschaltbefehl ist raus, der Beamer meldet sich aber noch nicht als an. */
	| "warming"
	/** Nicht erreichbar. */
	| "offline";

export interface BeamerState {
	phase: PowerPhase;
	/** Verbleibende Abkuehlzeit in Sekunden, nur bei phase === "cooling". */
	cooldownLeft: number;
	/** Rohwert der Statusseite, z.B. "Power On" oder "Standby". */
	syssta: string;
}

/**
 * Dauer der Abkuehlphase. Gemessen wurden 156 s, bis ein Einschaltbefehl
 * wieder angenommen wurde; mit Reserve gerundet.
 */
export const COOLDOWN_MS = 180_000;

/** Nach so langer Zeit ohne Erfolg gilt ein Einschaltvorgang als gescheitert. */
export const WARMUP_TIMEOUT_MS = 300_000;

const TIMEOUT_MS = 8_000;

export interface BeamerClientOptions {
	/** Dauer der Abkuehlphase in ms. Ueberschreibbar fuer Tests. */
	cooldownMs?: number;
	/** Zeitfenster, in dem ein Einschaltvorgang als "laeuft noch" gilt. */
	warmupTimeoutMs?: number;
}

/**
 * Zerlegt ein JS-Objektliteral mit unquotierten Keys.
 * Die Weboberflaeche jagt die Antwort durch eval, JSON.parse scheitert daran.
 */
function parseLiteral(body: string): Record<string, string> | null {
	const block = body.match(/\{[^{}]*\}/);
	if (!block) {
		return null;
	}

	const out: Record<string, string> = {};
	for (const [, key, value] of block[0].matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) {
		out[key] = value;
	}

	return Object.keys(out).length ? out : null;
}

export class BeamerClient {
	#baseUrl: string;
	#cookie = "";
	#ready = false;

	/** Zeitpunkt, ab dem wieder eingeschaltet werden darf (Ende der Abkuehlphase). */
	#coolingUntil = 0;
	/** Zeitpunkt, zu dem zuletzt ein Einschaltbefehl rausging. */
	#warmingSince = 0;
	/** Letzter bekannter pwr-Wert, um Uebergaenge zu erkennen. */
	#lastPwr: string | null = null;

	readonly #cooldownMs: number;
	readonly #warmupTimeoutMs: number;

	constructor(baseUrl: string, options: BeamerClientOptions = {}) {
		this.#baseUrl = baseUrl.replace(/\/+$/, "");
		this.#cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
		this.#warmupTimeoutMs = options.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS;
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	/** Adresse wechseln (wenn der Nutzer sie in den Einstellungen aendert). */
	setBaseUrl(baseUrl: string): void {
		const next = baseUrl.replace(/\/+$/, "");
		if (next === this.#baseUrl) {
			return;
		}

		this.#baseUrl = next;
		this.#reset();
		this.#coolingUntil = 0;
		this.#warmingSince = 0;
		this.#lastPwr = null;
	}

	async #request(path: string, init: RequestInit = {}): Promise<string> {
		const res = await fetch(this.#baseUrl + path, {
			...init,
			headers: { ...(init.headers ?? {}), ...(this.#cookie ? { cookie: this.#cookie } : {}) },
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		const setCookie = res.headers.getSetCookie?.() ?? [];
		if (setCookie.length) {
			this.#cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
		}

		return res.text();
	}

	#reset(): void {
		this.#cookie = "";
		this.#ready = false;
	}

	/**
	 * Session aufbauen. Der Server antwortet auf control.tgi erst dann mit Daten,
	 * wenn vorher die regulaeren Seiten abgerufen wurden.
	 */
	async #open(): Promise<void> {
		if (this.#ready) {
			return;
		}

		await this.#request("/");
		await this.#request("/home.htm");
		await this.#request("/control.htm");
		this.#ready = true;
	}

	/**
	 * Befehl senden. Verliert der Server die Session, antwortet er mit HTML
	 * statt mit Daten - dann wird die Session neu aufgebaut und erneut versucht.
	 */
	async send(command: string, attempts = 3): Promise<Record<string, string>> {
		for (let attempt = 1; attempt <= attempts; attempt++) {
			await this.#open();
			const body = await this.#request("/tgi/control.tgi", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: command,
			});

			const state = parseLiteral(body);
			if (state) {
				return state;
			}

			this.#reset();
		}

		throw new Error(`Beamer antwortet auf "${command}" nicht mit Daten.`);
	}

	/** Klartext-Status von der Startseite. Braucht keine Session. */
	async #syssta(): Promise<string> {
		const res = await fetch(`${this.#baseUrl}/home.htm`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const html = await res.text();
		return html.match(/ID="syssta"[^>]*>([^<]*)</i)?.[1]?.trim() ?? "";
	}

	/**
	 * Aktuellen Zustand ermitteln.
	 *
	 * Der Beamer selbst unterscheidet nicht zwischen "aus" und "kuehlt noch ab" -
	 * beides meldet er als Standby. Die Abkuehlphase wird deshalb aus dem
	 * beobachteten Uebergang an -> aus abgeleitet. Meldet die Statusseite doch
	 * einen eigenen Begriff (etwa "Cooling"), hat der Vorrang.
	 */
	async getState(): Promise<BeamerState> {
		let syssta = "";
		let pwr: string | undefined;

		try {
			[syssta, pwr] = await Promise.all([
				this.#syssta(),
				this.send("QueryControl").then((s) => s.pwr),
			]);
		} catch {
			return { phase: "offline", cooldownLeft: 0, syssta: "" };
		}

		const now = Date.now();

		// Uebergang an -> aus: ab hier laeuft die Abkuehlphase.
		if (this.#lastPwr === "1" && pwr === "0") {
			this.#coolingUntil = now + this.#cooldownMs;
			this.#warmingSince = 0;
		}
		// Angekommen: kein Aufwaermen mehr.
		if (pwr === "1") {
			this.#warmingSince = 0;
			this.#coolingUntil = 0;
		}
		this.#lastPwr = pwr ?? null;

		if (pwr === "1") {
			return { phase: "on", cooldownLeft: 0, syssta };
		}

		// Geraeteeigene Meldung hat Vorrang, falls es eine gibt.
		if (/cool/i.test(syssta)) {
			return {
				phase: "cooling",
				cooldownLeft: Math.max(0, Math.ceil((this.#coolingUntil - now) / 1000)),
				syssta,
			};
		}

		if (now < this.#coolingUntil) {
			return {
				phase: "cooling",
				cooldownLeft: Math.ceil((this.#coolingUntil - now) / 1000),
				syssta,
			};
		}

		if (this.#warmingSince && now - this.#warmingSince < this.#warmupTimeoutMs) {
			return { phase: "warming", cooldownLeft: 0, syssta };
		}

		this.#warmingSince = 0;
		return { phase: "off", cooldownLeft: 0, syssta };
	}

	/** Einschalten. Waehrend der Abkuehlphase verwirft der Beamer das kommentarlos. */
	async powerOn(): Promise<void> {
		this.#warmingSince = Date.now();
		await this.send("pwr=Power ON");
	}

	/** Ausschalten. Startet die Abkuehlphase. */
	async powerOff(): Promise<void> {
		this.#coolingUntil = Date.now() + this.#cooldownMs;
		this.#warmingSince = 0;
		await this.send("pwr=Power OFF");
	}

	/** Erneut einen Einschaltbefehl schicken, ohne den Aufwaerm-Zeitstempel zu verlieren. */
	async retryPowerOn(): Promise<void> {
		await this.send("pwr=Power ON");
	}
}
