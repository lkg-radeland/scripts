// Gemeinsamer Ablauf fuer den Acer Projector Web Server:
// einloggen, Control Panel oeffnen, Power-Button schalten.
// URL und Passwort stehen in config.json.
const path = require('path');
const { chromium } = require('playwright');

const config = require(path.join(__dirname, 'config.json'));

/**
 * Schaltet den Beamer.
 * @param {'on'|'off'} target Gewuenschter Zustand.
 * @param {{headed?: boolean}} opts
 * @returns {Promise<boolean>} true, wenn geklickt wurde; false, wenn der Zustand schon passte.
 */
async function setPower(target, opts = {}) {
  const headed = Boolean(opts.headed);
  const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 300 : 0 });
  const page = await browser.newPage();

  // Der Webserver bestaetigt Aktionen teils per confirm()/alert().
  page.on('dialog', async dialog => {
    console.log(`Dialog: ${dialog.message()}`);
    await dialog.accept();
  });

  try {
    console.log(`Oeffne ${config.url} ...`);
    await page.goto(config.url, { waitUntil: 'load', timeout: 20000 });

    // Login als Administrator; die Challenge-Response rechnet die Seite selbst aus.
    console.log('Logge ein (Administrator) ...');
    const loginFrame = page.frameLocator('#iframe');
    await loginFrame.locator('#login_pwd').fill(config.password);
    await loginFrame.locator('input.btn[value="Login"]').click();

    // Nach erfolgreichem Login wird die Navigationsleiste eingeblendet.
    await page.locator('#navigator').waitFor({ state: 'visible', timeout: 15000 });
    console.log('Login erfolgreich.');

    console.log('Klicke "Control Panel" ...');
    await page.locator('#nav_control').click();

    const powerButton = page.frameLocator('#iframe[src*="control"]').locator('#pwr');
    await powerButton.waitFor({ state: 'visible', timeout: 15000 });

    // Der Button zeigt immer die Aktion an, die er ausloest: "Power ON" bzw. "Power OFF".
    const label = await powerButton.inputValue();
    if (!new RegExp(target, 'i').test(label)) {
      console.log(`Beamer ist bereits ${target === 'on' ? 'an' : 'aus'} (Button zeigt "${label}") - nichts zu tun.`);
      return false;
    }

    console.log(`Klicke "${label}" ...`);
    await powerButton.click();
    await page.waitForTimeout(3000);

    console.log(`Power ${target.toUpperCase()} gesendet.`);
    return true;
  } catch (err) {
    console.error('Fehler:', err.message);
    await page.screenshot({ path: `beamer-error-${target}.png`, fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

/** Wrapper fuer die CLI-Scripts: wertet --headed aus und setzt den Exit-Code. */
function run(target) {
  setPower(target, { headed: process.argv.includes('--headed') })
    .catch(() => process.exit(1));
}

module.exports = { setPower, run, config };
