// Générateur de Documents MA — application autonome côté client (formulaires,
// aperçu, export Word/PDF tournent entièrement dans le navigateur). Ce
// serveur sert les fichiers statiques et expose une API de sauvegarde cloud
// optionnelle (compte par code, sans mot de passe) : l'app fonctionne très
// bien sans jamais y toucher, elle reste utile pour retrouver ses données
// sur un autre appareil.
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// puppeteer est un module ESM : require() plante avec ERR_REQUIRE_ESM, il
// faut un import() dynamique. Le navigateur Chromium est coûteux à lancer,
// donc on le garde ouvert entre deux appels plutôt que d'en relancer un par
// PDF (retenu de l'intégration identique sur Tijara).
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const puppeteer = (await import('puppeteer')).default;
    return puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  })();
  browserPromise.catch(() => { browserPromise = null; }); // relance possible après un échec transitoire
  return browserPromise;
}
async function renderPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
  } finally {
    await page.close();
  }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5e6) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API sauvegarde cloud ────────────────────────────────────
  // POST /api/register — crée un compte avec un code unique généré serveur
  // (vérifié en base). Ce code est ensuite le seul identifiant nécessaire
  // pour sauvegarder/restaurer les données sur n'importe quel appareil.
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 80);
    if (!name) return sendJSON(res, 400, { error: 'Le nom est obligatoire' });
    try {
      const user = await db.registerUser(name);
      return sendJSON(res, 200, user);
    } catch (e) {
      console.error('Erreur inscription:', e);
      return sendJSON(res, 500, { error: 'Échec de la création du compte' });
    }
  }

  if (pathname.match(/^\/api\/user\/[A-Z0-9]{4,12}$/) && req.method === 'GET') {
    const code = pathname.split('/')[3];
    try {
      const user = await db.getUser(code);
      if (!user) return sendJSON(res, 404, { error: 'Compte introuvable' });
      return sendJSON(res, 200, user);
    } catch (e) {
      console.error('Erreur lecture compte:', e);
      return sendJSON(res, 500, { error: 'Échec de la lecture du compte' });
    }
  }

  // POST /api/sync — sauvegarde les données d'un compte déjà inscrit. Un
  // code inconnu n'est jamais créé à la volée : il faut s'être inscrit via
  // /api/register, pour que chaque sauvegarde soit bien rattachée à un
  // compte (nom + code), pas à un code anonyme généré en douce.
  if (pathname === '/api/sync' && req.method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.data !== 'object' || body.data === null) return sendJSON(res, 400, { error: 'data requis' });
    const code = typeof body.code === 'string' ? body.code : '';
    if (!/^[A-Z0-9]{4,12}$/.test(code)) return sendJSON(res, 400, { error: 'Compte requis — créez-en un d\'abord.' });
    try {
      const updatedAt = await db.saveBackup(code, body.data);
      if (!updatedAt) return sendJSON(res, 404, { error: 'Compte introuvable' });
      return sendJSON(res, 200, { code, updatedAt });
    } catch (e) {
      console.error('Erreur sauvegarde sync:', e);
      return sendJSON(res, 500, { error: 'Échec de la sauvegarde' });
    }
  }

  if (pathname.match(/^\/api\/sync\/[A-Z0-9]{4,12}$/) && req.method === 'GET') {
    const code = pathname.split('/')[3];
    try {
      const rec = await db.loadBackup(code);
      if (!rec) return sendJSON(res, 404, { error: 'Code introuvable' });
      return sendJSON(res, 200, rec);
    } catch (e) {
      console.error('Erreur restauration sync:', e);
      return sendJSON(res, 500, { error: 'Échec de la restauration' });
    }
  }

  // POST /api/pdf — rendu PDF serveur (Puppeteer), en complément du bouton
  // d'impression navigateur : rendu identique quel que soit le
  // navigateur/OS du client, sans dépendre de son moteur d'impression.
  if (pathname === '/api/pdf' && req.method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.html !== 'string' || !body.html.trim()) return sendJSON(res, 400, { error: 'html requis' });
    try {
      const pdf = await renderPdf(body.html);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': `attachment; filename="${(body.filename || 'document').replace(/[^a-zA-Z0-9_\-.]/g, '_')}.pdf"`,
      });
      return res.end(pdf);
    } catch (e) {
      console.error('Erreur génération PDF:', e);
      return sendJSON(res, 500, { error: 'Échec de la génération du PDF côté serveur' });
    }
  }

  // ── Fichiers statiques ─────────────────────────────────────
  let filePath = path.join(ROOT, decodeURIComponent(pathname));
  if (pathname === '/') filePath = path.join(ROOT, 'index.html');
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

db.initDb()
  .then(() => {
    server.listen(PORT, () => console.log('Générateur de Documents MA servi sur le port ' + PORT));
  })
  .catch(e => {
    console.error('Échec initialisation base de données:', e);
    // La sauvegarde cloud restera indisponible, mais l'app statique doit
    // quand même démarrer plutôt que de tout bloquer (elle marche très bien
    // sans compte cloud).
    server.listen(PORT, () => console.log('Générateur de Documents MA servi sur le port ' + PORT + ' (sans DB)'));
  });
