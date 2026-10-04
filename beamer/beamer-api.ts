// Steuerung des Acer Projector Web Servers ueber seinen eigenen HTTP-Endpunkt,
// ohne Browser. Nachgebaut aus der JavaScript-Logik der Weboberflaeche.
//
// Protokoll (alles form-urlencoded an POST /tgi/control.tgi):
//   QueryControl    -> kompletter Zustand
//   pwr=Power ON    -> einschalten
//   pwr=Power OFF   -> ausschalten
// Die Antwort ist ein JS-Objektliteral mit unquotierten Keys, kein JSON.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PowerTarget = 'on' | 'off';

export interface Config {
  /** Basis-URL des Beamer-Webservers. */
  url: string;
  /** Passwort des Benutzers "Administrator"; leer, wenn keines gesetzt ist. */
  password: string;
}

/** Zustand aus QueryControl. Werte sind durchweg Zahlen-Strings. */
export interface ControlState {
  /** "1" = an, "0" = aus. */
  pwr?: string;
  hid?: string;
  frz?: string;
  eco?: string;
  src?: string;
  bri?: string;
  con?: string;
  vol?: string;
  [key: string]: string | undefined;
}

/** Die Klartext-Statusseite, die auch ohne Session abrufbar ist. */
export interface Status {
  model: string;
  /** z.B. "Power On" oder "Standby". */
  syssta: string;
  dissrc: string;
  /** Lampenstunden. */
  lamphr: string;
  dismod: string;
  errsta: string;
}

export interface SetPowerOptions {
  /**
   * Maximale Wartezeit, bis der Beamer den Zustand meldet. Default 300 s.
   * Gemessen wurden 156 s fuers Einschalten aus der Abkuehlphase heraus,
   * der Default laesst also reichlich Luft nach oben.
   */
  timeoutMs?: number;
  /** Abstand zwischen zwei Statusabfragen. Default 10 s. */
  pollIntervalMs?: number;
  /** Fortschritt ausgeben. Default true. */
  verbose?: boolean;
}

export const config = JSON.parse(
  readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'),
) as Config;

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Zerlegt ein JS-Objektliteral mit unquotierten Keys, wie der Beamer es liefert.
 * JSON.parse scheitert daran, weil die Keys nicht in Anfuehrungszeichen stehen.
 */
function parseLiteral(body: string): Record<string, string> | null {
  const block = body.match(/\{[^{}]*\}/);
  if (!block) return null;
  const out: Record<string, string> = {};
  for (const [, key, value] of block[0].matchAll(/(\w+)\s*:\s*"([^"]*)"/g)) out[key] = value;
  return Object.keys(out).length ? out : null;
}

/**
 * Eine HTTP-Sitzung mit dem Beamer.
 *
 * Der Webserver ist eigen: control.tgi antwortet erst dann mit Daten, wenn vorher
 * die regulaeren Seiten abgerufen wurden. Sonst kommt stillschweigend HTML zurueck.
 */
export class BeamerSession {
  #cookie = '';
  #ready = false;
  readonly base: string;

  // Keine Parameter-Property: die waere nicht loeschbar und damit
  // unter erasableSyntaxOnly nicht erlaubt.
  constructor(base: string = config.url) {
    this.base = base;
  }

  async #req(path: string, init: RequestInit = {}): Promise<string> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(this.#cookie ? { cookie: this.#cookie } : {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) this.#cookie = setCookie.map(c => c.split(';')[0]).join('; ');
    return res.text();
  }

  /** Session aufbauen: Cookie holen, bei Bedarf einloggen, Seiten "besuchen". */
  async open(): Promise<void> {
    if (this.#ready) return;

    await this.#req('/'); // setzt den ATOP-Cookie
    const home = await this.#req('/home.htm');

    // Nur wenn der Beamer ein Passwort verlangt, steht hier eine Challenge.
    const challenge = home.match(/id="Challenge"\s+value="([^"]*)"/i)?.[1];
    if (challenge) {
      const body = `Username=1&Response=${md5('admin' + config.password + challenge)}`;
      const res = await this.#req('/tgi/login.tgi', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (parseLiteral(res)?.loginstatus !== '1') {
        throw new Error('Login fehlgeschlagen - Passwort in config.json pruefen.');
      }
    }

    await this.#req('/control.htm');
    this.#ready = true;
  }

  /**
   * Einen Befehl an control.tgi schicken und den zurueckgemeldeten Zustand lesen.
   *
   * Der Server verliert gelegentlich die Session und antwortet dann mit HTML
   * statt mit Daten. In dem Fall wird die Session neu aufgebaut und erneut
   * versucht, statt den Aufruf scheitern zu lassen.
   */
  async send(command: string, attempts = 3): Promise<ControlState> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.open();
      const body = await this.#req('/tgi/control.tgi', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: command,
      });
      const state = parseLiteral(body);
      if (state) return state;

      this.#reset();
      if (attempt < attempts) await sleep(1000);
    }
    throw new Error(
      `Beamer antwortet auf "${command}" nicht mit Daten (${attempts} Versuche).`,
    );
  }

  /** Session verwerfen, damit der naechste Aufruf neu anmeldet. */
  #reset(): void {
    this.#cookie = '';
    this.#ready = false;
  }

  /** Kompletten Steuerzustand abfragen. */
  query(): Promise<ControlState> {
    return this.send('QueryControl');
  }
}

/**
 * Liest die Klartext-Statusseite. Braucht keine Session und kein Passwort und
 * liefert als einzige Quelle Lampenstunden und Fehlerstatus.
 */
export async function getStatus(base: string = config.url): Promise<Status> {
  const res = await fetch(`${base}/home.htm`, { signal: AbortSignal.timeout(10000) });
  const html = await res.text();
  const field = (id: string): string =>
    html.match(new RegExp(`ID="${id}"[^>]*>([^<]*)<`, 'i'))?.[1]?.trim() ?? '';

  const status: Status = {
    model: field('model'),
    syssta: field('syssta'),
    dissrc: field('dissrc'),
    lamphr: field('lamphr'),
    dismod: field('dismod'),
    errsta: field('errsta'),
  };
  if (!status.syssta) throw new Error('Statusseite nicht lesbar - ist die URL richtig?');
  return status;
}

/**
 * Schaltet den Beamer und wartet, bis er den Zustand tatsaechlich meldet.
 *
 * Nach dem Ausschalten kuehlt die Lampe ab; in dieser Zeit verwirft der Beamer
 * Einschaltbefehle kommentarlos. Deshalb wird nicht blind gesendet, sondern
 * gepollt und zwischendurch nachgefasst.
 *
 * @returns true, wenn geschaltet wurde; false, wenn der Zustand schon passte.
 */
export async function setPower(target: PowerTarget, opts: SetPowerOptions = {}): Promise<boolean> {
  const { timeoutMs = 300000, pollIntervalMs = 10000, verbose = true } = opts;
  const wanted = target === 'on' ? '1' : '0';
  const log = (msg: string): void => { if (verbose) console.log(msg); };

  const session = new BeamerSession();
  log(`Verbinde mit ${config.url} ...`);

  if ((await session.query()).pwr === wanted) {
    log(`Beamer ist bereits ${target === 'on' ? 'an' : 'aus'} - nichts zu tun.`);
    return false;
  }

  const command = target === 'on' ? 'pwr=Power ON' : 'pwr=Power OFF';
  log(`Sende "${command}" ...`);
  await session.send(command);

  const deadline = Date.now() + timeoutMs;
  let resendAt = Date.now() + pollIntervalMs * 3;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const { pwr } = await session.query();
    if (pwr === wanted) {
      log(`Beamer ist jetzt ${target === 'on' ? 'an' : 'aus'}.`);
      return true;
    }
    // Waehrend der Abkuehlphase werden Befehle verworfen - also nachfassen.
    if (Date.now() >= resendAt) {
      log('  noch nicht umgeschaltet, sende erneut ...');
      await session.send(command);
      resendAt = Date.now() + pollIntervalMs * 3;
    }
  }

  throw new Error(
    `Beamer hat nach ${Math.round(timeoutMs / 1000)} s nicht auf "${target}" geschaltet.`,
  );
}

/** Wrapper fuer die CLI-Scripts: setzt den Exit-Code. */
export function run(target: PowerTarget): void {
  setPower(target).catch((err: unknown) => {
    console.error('Fehler:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
