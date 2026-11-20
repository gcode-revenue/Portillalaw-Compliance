'use strict';
// Primer arranque en producción: si no existe ningún usuario, crea la cuenta del
// presidente con ADMIN_EMAIL / ADMIN_PASSWORD (variables de entorno del servidor).
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return null;
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 8) {
    console.warn('[inicio] No hay usuarios. Defina ADMIN_EMAIL y ADMIN_PASSWORD (mín. 8 caracteres) para crear la cuenta del presidente.');
    return null;
  }
  const r = db.prepare("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')")
    .run(process.env.ADMIN_NAME || 'Presidente Portilla Law', email, process.env.ADMIN_PHONE || null, bcrypt.hashSync(password, 10));
  audit(null, 'crear_admin_inicial', 'user', r.lastInsertRowid, { email });
  console.log(`[inicio] Cuenta del presidente creada: ${email}`);
  return r.lastInsertRowid;
}

module.exports = { ensureAdmin };
