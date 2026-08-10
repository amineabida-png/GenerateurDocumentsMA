// Persistance de la sauvegarde cloud optionnelle, sur le Postgres partagé du
// projet Railway, isolée dans son propre schéma ("generateurdocuments") pour
// ne rien croiser avec les autres applications qui utilisent la même base
// (même principe que Tijara et Lingua). Chaque compte est protégé par un
// mot de passe (haché, jamais stocké en clair) : le code seul ne suffit
// plus à lire ou écrire les données d'un compte. Les appels courants
// (synchro en arrière-plan) utilisent un jeton de session obtenu après
// vérification du mot de passe, pour ne jamais garder le mot de passe en
// clair côté client au-delà de la connexion initiale.
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query('CREATE SCHEMA IF NOT EXISTS generateurdocuments');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generateurdocuments.users (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generateurdocuments.backups (
      code TEXT PRIMARY KEY REFERENCES generateurdocuments.users(code) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS generateurdocuments.sessions (
      token TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES generateurdocuments.users(code) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
  // Migration : ajout du mot de passe sur un schéma qui pouvait exister sans
  // (première version, sans authentification). Les comptes créés avant
  // cette migration n'ont pas de mot de passe : ils sont purgés (avec leur
  // sauvegarde, via ON DELETE CASCADE) plutôt que laissés accessibles sans
  // protection.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='generateurdocuments' AND table_name='users' AND column_name='password_hash') THEN
        ALTER TABLE generateurdocuments.users ADD COLUMN password_hash TEXT;
        ALTER TABLE generateurdocuments.users ADD COLUMN password_salt TEXT;
      END IF;
    END $$;
  `);
  await pool.query('DELETE FROM generateurdocuments.users WHERE password_hash IS NULL');
}

// Alphabet sans caractères ambigus (0/O, 1/I) — plus facile à retaper sur un
// autre appareil.
function generateCandidateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

function genSalt() { return crypto.randomBytes(16).toString('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function safeEqual(hexA, hexB) {
  const a = Buffer.from(hexA, 'hex'), b = Buffer.from(hexB, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function codeExists(code) {
  const { rows } = await pool.query('SELECT 1 FROM generateurdocuments.users WHERE code = $1', [code]);
  return rows.length > 0;
}

async function registerUser(name, password) {
  let code = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateCandidateCode();
    if (!(await codeExists(candidate))) { code = candidate; break; }
  }
  if (!code) throw new Error('Impossible de générer un code unique, réessayez.');
  const now = new Date().toISOString();
  const salt = genSalt();
  const hash = hashPassword(password, salt);
  await pool.query(
    'INSERT INTO generateurdocuments.users (code, name, password_hash, password_salt, created_at) VALUES ($1, $2, $3, $4, $5)',
    [code, name, hash, salt, now]
  );
  await pool.query('INSERT INTO generateurdocuments.backups (code, data, updated_at) VALUES ($1, $2, $3)', [code, {}, now]);
  const token = await createSession(code);
  return { code, name, createdAt: now, token };
}

async function getUser(code) {
  const { rows } = await pool.query('SELECT code, name, created_at FROM generateurdocuments.users WHERE code = $1', [code]);
  if (!rows.length) return null;
  return { code: rows[0].code, name: rows[0].name, createdAt: rows[0].created_at.toISOString() };
}

// Vérifie code + mot de passe et ouvre une session (jeton) si valides.
// Message générique en cas d'échec (ne distingue pas "code inconnu" de
// "mot de passe incorrect") pour ne pas laisser deviner quels codes existent.
async function login(code, password) {
  const { rows } = await pool.query('SELECT password_hash, password_salt FROM generateurdocuments.users WHERE code = $1', [code]);
  if (!rows.length) return null;
  const hash = hashPassword(password, rows[0].password_salt);
  if (!safeEqual(hash, rows[0].password_hash)) return null;
  const token = await createSession(code);
  const user = await getUser(code);
  return { ...user, token };
}

async function createSession(code) {
  const token = genToken();
  await pool.query('INSERT INTO generateurdocuments.sessions (token, code, created_at) VALUES ($1, $2, $3)', [token, code, new Date().toISOString()]);
  return token;
}

// Toute lecture/écriture des données passe par un jeton de session valide,
// jamais par le code seul : c'est ce qui isole réellement un compte des
// autres (le code sert d'identifiant public, pas de secret d'accès).
async function codeForToken(token) {
  const { rows } = await pool.query('SELECT code FROM generateurdocuments.sessions WHERE token = $1', [token]);
  return rows.length ? rows[0].code : null;
}

async function destroySession(token) {
  await pool.query('DELETE FROM generateurdocuments.sessions WHERE token = $1', [token]);
}

async function saveBackup(code, data) {
  const updatedAt = new Date().toISOString();
  const { rowCount } = await pool.query(
    `UPDATE generateurdocuments.backups SET data = $2, updated_at = $3 WHERE code = $1`,
    [code, data, updatedAt]
  );
  if (!rowCount) return null;
  return updatedAt;
}

async function loadBackup(code) {
  const { rows } = await pool.query('SELECT data, updated_at FROM generateurdocuments.backups WHERE code = $1', [code]);
  if (!rows.length) return null;
  return { data: rows[0].data, updatedAt: rows[0].updated_at.toISOString() };
}

module.exports = { initDb, registerUser, getUser, login, codeForToken, destroySession, saveBackup, loadBackup };
