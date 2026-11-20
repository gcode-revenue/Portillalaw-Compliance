'use strict';
// Enlaces de un solo clic (confirmar asistencia / check-in / reporte) firmados con HMAC,
// para que el empleado pueda responder desde el email o SMS sin iniciar sesión.
const crypto = require('node:crypto');
const SECRET = process.env.APP_SECRET || 'dev-secret-cambiar-en-produccion';

function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url').slice(0, 22); }

function makeToken(action, assignmentId, ttlHours = 24 * 14) {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const payload = `${action}.${assignmentId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [action, id, exp, sig] = parts;
  const expected = sign(`${action}.${id}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return { action, assignmentId: Number(id) };
}

module.exports = { makeToken, verifyToken };
