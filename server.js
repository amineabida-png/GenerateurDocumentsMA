// Générateur de Documents MA — application autonome côté client (formulaires,
// aperçu, export Word/PDF tournent entièrement dans le navigateur). Ce
// serveur sert les fichiers statiques et expose une API de sauvegarde cloud
// optionnelle (compte par code + mot de passe) : l'app fonctionne très bien
// sans jamais y toucher, elle reste utile pour retrouver ses données sur un
// autre appareil, chaque compte étant isolé par mot de passe.
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
  // Chaque compte est protégé par un mot de passe (haché en base, jamais
  // stocké en clair). Le code seul n'ouvre plus jamais l'accès aux données :
  // toute lecture/écriture passe par un jeton de session obtenu après
  // vérification du mot de passe (via /api/register ou /api/login), ce qui
  // isole réellement chaque compte des autres.

  // POST /api/register {name,password} — crée un compte avec un code unique
  // généré serveur, retourne un jeton de session déjà valide.
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = (typeof body.name === 'string' ? body.name : '').trim().slice(0, 80);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!name) return sendJSON(res, 400, { error: 'Le nom est obligatoire' });
    if (password.length < 6) return sendJSON(res, 400, { error: 'Le mot de passe doit faire au moins 6 caractères.' });
    try {
      const user = await db.registerUser(name, password);
      return sendJSON(res, 200, user);
    } catch (e) {
      console.error('Erreur inscription:', e);
      return sendJSON(res, 500, { error: 'Échec de la création du compte' });
    }
  }

  // POST /api/login {code,password} — vérifie le mot de passe et retourne
  // un nouveau jeton de session (pour se reconnecter sur un autre appareil).
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const code = (typeof body.code === 'string' ? body.code : '').trim().toUpperCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[A-Z0-9]{4,12}$/.test(code) || !password) return sendJSON(res, 400, { error: 'Code et mot de passe requis.' });
    try {
      const session = await db.login(code, password);
      if (!session) return sendJSON(res, 401, { error: 'Code ou mot de passe incorrect.' });
      return sendJSON(res, 200, session);
    } catch (e) {
      console.error('Erreur connexion:', e);
      return sendJSON(res, 500, { error: 'Échec de la connexion' });
    }
  }

  // POST /api/logout {token} — invalide la session côté serveur.
  if (pathname === '/api/logout' && req.method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.token === 'string' && body.token) await db.destroySession(body.token).catch(() => {});
    return sendJSON(res, 200, { ok: true });
  }

  // POST /api/sync {token,data} — sauvegarde les données du compte propriétaire du jeton.
  if (pathname === '/api/sync' && req.method === 'POST') {
    const body = await parseBody(req);
    if (typeof body.data !== 'object' || body.data === null) return sendJSON(res, 400, { error: 'data requis' });
    const token = typeof body.token === 'string' ? body.token : '';
    try {
      const code = token && await db.codeForToken(token);
      if (!code) return sendJSON(res, 401, { error: 'Session expirée — reconnectez-vous.' });
      const updatedAt = await db.saveBackup(code, body.data);
      if (!updatedAt) return sendJSON(res, 404, { error: 'Compte introuvable' });
      return sendJSON(res, 200, { updatedAt });
    } catch (e) {
      console.error('Erreur sauvegarde sync:', e);
      return sendJSON(res, 500, { error: 'Échec de la sauvegarde' });
    }
  }

  // POST /api/restore {token} — récupère les données du compte propriétaire du jeton.
  if (pathname === '/api/restore' && req.method === 'POST') {
    const body = await parseBody(req);
    const token = typeof body.token === 'string' ? body.token : '';
    try {
      const code = token && await db.codeForToken(token);
      if (!code) return sendJSON(res, 401, { error: 'Session expirée — reconnectez-vous.' });
      const rec = await db.loadBackup(code);
      if (!rec) return sendJSON(res, 404, { error: 'Compte introuvable' });
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
