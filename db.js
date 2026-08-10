// Persistance de la sauvegarde cloud optionnelle, sur le Postgres partagé du
// projet Railway, isolée dans son propre schéma ("generateurdocuments") pour
// ne rien croiser avec les autres applications qui utilisent la même base
// (même principe que Tijara et Lingua). Chaque utilisateur = une ligne dans
// generateurdocuments.users, identifiée par un code unique généré à
// l'inscription (pas de mot de passe : le code EST l'identifiant).
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
}

// Alphabet sans caractères ambigus (0/O, 1/I) — plus facile à retaper sur un
// autre appareil.
function generateCandidateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return s;
}

async function codeExists(code) {
  const { rows } = await pool.query('SELECT 1 FROM generateurdocuments.users WHERE code = $1', [code]);
  return rows.length > 0;
}

async function registerUser(name) {
  let code = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = generateCandidateCode();
    if (!(await codeExists(candidate))) { code = candidate; break; }
  }
  if (!code) throw new Error('Impossible de générer un code unique, réessayez.');
  const now = new Date().toISOString();
  await pool.query('INSERT INTO generateurdocuments.users (code, name, created_at) VALUES ($1, $2, $3)', [code, name, now]);
  await pool.query('INSERT INTO generateurdocuments.backups (code, data, updated_at) VALUES ($1, $2, $3)', [code, {}, now]);
  return { code, name, createdAt: now };
}

async function getUser(code) {
  const { rows } = await pool.query('SELECT code, name, created_at FROM generateurdocuments.users WHERE code = $1', [code]);
  if (!rows.length) return null;
  return { code: rows[0].code, name: rows[0].name, createdAt: rows[0].created_at.toISOString() };
}

async function saveBackup(code, data) {
  const updatedAt = new Date().toISOString();
  const { rowCount } = await pool.query(
    `UPDATE generateurdocuments.backups SET data = $2, updated_at = $3 WHERE code = $1`,
    [code, data, updatedAt]
  );
  if (!rowCount) return null; // code inconnu : pas de compte, pas de sauvegarde silencieuse
  return updatedAt;
}

async function loadBackup(code) {
  const { rows } = await pool.query('SELECT data, updated_at FROM generateurdocuments.backups WHERE code = $1', [code]);
  if (!rows.length) return null;
  return { data: rows[0].data, updatedAt: rows[0].updated_at.toISOString() };
}

module.exports = { initDb, registerUser, getUser, saveBackup, loadBackup };
