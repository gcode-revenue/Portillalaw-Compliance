'use strict';
const session = require('express-session');
const { db } = require('./db');

// --- Almacén de sesiones en SQLite ---
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 864e5;
      db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), expires);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) { try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb?.(null); } catch (e) { cb?.(e); } }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600000).unref();

// --- Roles y permisos ---
const ROLE_LABELS = { admin: 'Presidente / Administrador', staff: 'Personal Portilla Law', employer: 'Patrono (cliente)', employee: 'Empleado / Aprendiz' };
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'staff');
// Gastos: sólo el presidente (admin) o personas que él designe explícitamente.
const canSeeExpenses = (u) => u && (u.role === 'admin' || (u.role === 'staff' && !!u.can_view_expenses));

function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.userId);
    if (u) {
      req.user = u;
      res.locals.user = u;
      res.locals.unread = db.prepare('SELECT COUNT(*) c FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(u.id).c;
      res.locals.openAlerts = isStaff(u)
        ? db.prepare("SELECT COUNT(*) c FROM compliance_alerts WHERE status = 'abierta'").get().c
        : u.role === 'employer' ? db.prepare("SELECT COUNT(*) c FROM compliance_alerts WHERE status = 'abierta' AND company_id = ?").get(u.company_id).c : 0;
    } else {
      req.session.userId = null;
    }
  }
  res.locals.isStaff = isStaff(req.user);
  res.locals.canSeeExpenses = canSeeExpenses(req.user);
  res.locals.ROLE_LABELS = ROLE_LABELS;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!roles.includes(req.user.role)) return forbidden(res);
  next();
};
const requireStaff = requireRole('admin', 'staff');
function requireExpenses(req, res, next) {
  if (!canSeeExpenses(req.user)) return forbidden(res, 'Acceso a gastos restringido al presidente o personal designado.');
  next();
}
function forbidden(res, msg = 'No tiene permiso para acceder a esta sección.') {
  return res.status(403).render('error', { title: 'Acceso denegado', message: msg });
}

function canViewCompany(u, companyId) {
  return isStaff(u) || (u.role === 'employer' && u.company_id === Number(companyId));
}
function canViewEmployee(u, emp) {
  if (!emp) return false;
  if (isStaff(u)) return true;
  if (u.role === 'employer') return emp.company_id === u.company_id;
  return u.id === emp.id;
}

// Protección CSRF básica: los POST deben originarse en este mismo sitio.
function sameOrigin(req, res, next) {
  if (req.method !== 'POST' || req.path.startsWith('/webhooks/')) return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).send('Origen no permitido');
  } catch { return res.status(403).send('Origen no permitido'); }
  next();
}

module.exports = { SqliteStore, ROLE_LABELS, isStaff, canSeeExpenses, loadUser, requireLogin, requireRole, requireStaff, requireExpenses, forbidden, canViewCompany, canViewEmployee, sameOrigin };
