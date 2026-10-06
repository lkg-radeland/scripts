/**
 * Prueft den Zustandsautomaten von BeamerClient gegen einen simulierten Beamer.
 *
 * Simuliert wird auch das entscheidende Verhalten des echten Geraets: Waehrend
 * der Abkuehlphase nimmt es Einschaltbefehle entgegen, ignoriert sie aber.
 *
 *   node --test test/phases.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { BeamerClient } from "../src/beamer-client.ts";

/** Simulierter Beamer. */
class FakeProjector {
	server: Server;
	port = 0;
	/** "1" = an, "0" = aus. */
	pwr = "1";
	/** Bis zu diesem Zeitpunkt werden Einschaltbefehle verworfen. */
	acceptOnAfter = 0;
	/** Was die Statusseite als syssta meldet. */
	syssta = "Power On";

	constructor() {
		this.server = createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				if (req.url === "/tgi/control.tgi") {
					if (body === "pwr=Power ON" && Date.now() >= this.acceptOnAfter) {
						this.pwr = "1";
						this.syssta = "Power On";
					} else if (body === "pwr=Power OFF") {
						this.pwr = "0";
						this.syssta = "Standby";
					}
					res.setHeader("set-cookie", "ATOP=test");
					res.end(`{pwr:"${this.pwr}",hid:"0",frz:"0",M:"3"}`);
					return;
				}

				res.setHeader("set-cookie", "ATOP=test");
				res.end(
					`<html><body><td ID="syssta">${this.syssta}</td></body></html>`,
				);
			});
		});
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		const addr = this.server.address();
		if (addr && typeof addr === "object") {
			this.port = addr.port;
		}
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}
}

describe("BeamerClient Zustandsautomat", () => {
	const projector = new FakeProjector();

	before(async () => projector.start());
	after(async () => projector.stop());

	it("meldet 'on', wenn der Beamer laeuft", async () => {
		const client = new BeamerClient(projector.url);
		projector.pwr = "1";
		projector.syssta = "Power On";

		assert.equal((await client.getState()).phase, "on");
	});

	it("geht nach dem Ausschalten in 'cooling' und zaehlt herunter", async () => {
		const client = new BeamerClient(projector.url, { cooldownMs: 1500 });
		projector.pwr = "1";
		projector.syssta = "Power On";
		await client.getState(); // Ausgangszustand lernen

		await client.powerOff();
		const cooling = await client.getState();

		assert.equal(cooling.phase, "cooling");
		assert.ok(cooling.cooldownLeft > 0, "Restzeit sollte positiv sein");
	});

	it("wechselt nach Ablauf der Abkuehlphase auf 'off'", async () => {
		const client = new BeamerClient(projector.url, { cooldownMs: 300 });
		projector.pwr = "1";
		await client.getState();

		await client.powerOff();
		assert.equal((await client.getState()).phase, "cooling");

		await new Promise((r) => setTimeout(r, 400));
		assert.equal((await client.getState()).phase, "off");
	});

	it("zeigt 'warming', solange der Beamer den Einschaltbefehl verwirft", async () => {
		const client = new BeamerClient(projector.url, { cooldownMs: 50 });
		projector.pwr = "0";
		projector.syssta = "Standby";
		// Der simulierte Beamer ignoriert das Einschalten fuer 600 ms.
		projector.acceptOnAfter = Date.now() + 600;

		await new Promise((r) => setTimeout(r, 60));
		await client.powerOn();

		const warming = await client.getState();
		assert.equal(warming.phase, "warming");

		// Nach Ablauf greift ein erneuter Befehl.
		await new Promise((r) => setTimeout(r, 600));
		await client.retryPowerOn();
		assert.equal((await client.getState()).phase, "on");
	});

	it("bevorzugt eine geraeteeigene Cooling-Meldung", async () => {
		const client = new BeamerClient(projector.url, { cooldownMs: 1 });
		projector.pwr = "0";
		projector.syssta = "Cooling Down";

		assert.equal((await client.getState()).phase, "cooling");
	});

	it("meldet 'offline', wenn der Beamer nicht antwortet", async () => {
		const client = new BeamerClient("http://127.0.0.1:1");
		assert.equal((await client.getState()).phase, "offline");
	});
});
