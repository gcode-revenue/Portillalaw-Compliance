'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'portilla.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  address TEXT,
  program_name TEXT DEFAULT 'Programa de Aprendizaje Registrado',
  proposal_status TEXT DEFAULT 'planificacion', -- planificacion, sometida, aprobada, en_ejecucion, facturacion, cerrada
  proposal_notes TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff','employer','employee')),
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  job_title TEXT,
  required_hours REAL DEFAULT 0,          -- meta de horas de instrucción (empleados)
  can_view_expenses INTEGER DEFAULT 0,    -- sólo personal designado por el presidente
  notify_email INTEGER DEFAULT 1,
  notify_sms INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS trainings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  modality TEXT NOT NULL CHECK (modality IN ('video','presencial','zoom')),
  starts_at TEXT NOT NULL,                -- ISO UTC
  duration_min INTEGER NOT NULL DEFAULT 60,
  hours_credit REAL NOT NULL DEFAULT 1,
  location TEXT,
  meeting_url TEXT,                       -- Zoom o enlace de video
  instructor TEXT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  cancelled INTEGER DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'asignado'
    CHECK (status IN ('asignado','confirmado','en_curso','pendiente_reporte','completado','ausente','excusado')),
  confirmed_at TEXT,
  confirmed_via TEXT,
  checked_in_at TEXT,
  checked_out_at TEXT,
  completed_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (training_id, employee_id)
);

CREATE TABLE IF NOT EXISTS progress_reports (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attended_full INTEGER DEFAULT 1,
  summary TEXT NOT NULL,
  applied_how TEXT,
  questions TEXT,
  rating INTEGER,
  hours_reported REAL,
  submitted_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  review_notes TEXT
);

CREATE TABLE IF NOT EXISTS compliance_alerts (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('ausencia','sin_confirmar','sin_reporte','sin_respuesta')),
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','resuelta')),
  resolution TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (type, assignment_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT NOT NULL,
  also_email INTEGER DEFAULT 0,
  also_sms INTEGER DEFAULT 0,
  read_at TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Bitácora de toda comunicación automatizada o manual (email / sms / interna)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- recordatorio, solicitud_reporte, ausencia, sin_confirmar, reporte_semanal, mensaje, asignacion
  dedupe_key TEXT UNIQUE,      -- evita duplicados del programador
  channel TEXT NOT NULL,       -- email, sms, interna
  destination TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL,        -- enviado, simulado, fallido, omitido
  error TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  training_id INTEGER REFERENCES trainings(id) ON DELETE SET NULL,
  category TEXT NOT NULL,      -- instructor, local, materiales, plataforma, transporte, alimentos, otro
  description TEXT,
  vendor TEXT,
  amount REAL NOT NULL,
  incurred_on TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assign_emp ON assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_assign_status ON assignments(status);
CREATE INDEX IF NOT EXISTS idx_train_start ON trainings(starts_at);
CREATE INDEX IF NOT EXISTS idx_msg_rcpt ON messages(recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
`);

const DEFAULT_SETTINGS = {
  reminder_offsets_min: '1440,720,60,30,5',      // 24h, 12h, 1h, 30m, 5m
  checkin_open_min: '15',                        // check-in abre X min antes
  absence_grace_min: '15',                       // gracia tras finalizar antes de marcar ausente
  report_followup_hours: '24,48',                // seguimientos para el progress report
  report_overdue_hours: '72',                    // alerta si no hay reporte
  unconfirmed_alert_min: '1440',                 // alerta si no confirmó a 24h
  unconfirmed_employer_min: '720',               // avisar al patrono si no confirmó a 12h
  weekly_report_cron: '0 8 * * 1',               // lunes 8:00 AM hora PR
  org_name: 'Portilla Law',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
function numList(key) {
  return String(getSetting(key) || '')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
}

function audit(userId, action, entity, entityId, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(userId ?? null, action, entity ?? null, entityId ?? null, details ? JSON.stringify(details) : null);
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, getSetting, setSetting, numList, audit, tx, DEFAULT_SETTINGS };
