'use strict';
// Datos de demostración. Uso: npm run seed   (borra y recrea data/portilla.db)
const fs = require('node:fs');
const path = require('node:path');
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'portilla.db');
if (dbPath !== ':memory:') for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);

const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const pw = bcrypt.hashSync('Portilla2026!', 10);
const H = 3600000;
const at = (h) => new Date(Date.now() + h * H).toISOString();

const user = (name, email, role, company, extra = {}) => db.prepare(`INSERT INTO users (name, email, phone, password_hash, role, company_id, job_title, required_hours, can_view_expenses)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(name, email, extra.phone || null, pw, role, company, extra.job || null, extra.hours || 0, extra.exp ? 1 : 0).lastInsertRowid;

const admin = user('Presidente Portilla Law', 'admin@portillalaw.com', 'admin', null, { phone: '787-555-0100' });
user('Coordinadora de Cumplimiento', 'staff@portillalaw.com', 'staff', null, { phone: '787-555-0101' });
user('Contable Designado', 'finanzas@portillalaw.com', 'staff', null, { exp: true });

const c1 = db.prepare("INSERT INTO companies (name, contact_name, contact_email, contact_phone, address, proposal_status) VALUES (?,?,?,?,?,?)")
  .run('Constructora del Caribe, LLC', 'María Rivera', 'maria@constructoracaribe.com', '787-555-0200', 'Bayamón, PR', 'en_ejecucion').lastInsertRowid;
const c2 = db.prepare("INSERT INTO companies (name, contact_name, contact_email, contact_phone, address, proposal_status) VALUES (?,?,?,?,?,?)")
  .run('Servicios Médicos Borinquen', 'José Torres', 'jose@smborinquen.com', '787-555-0300', 'Ponce, PR', 'aprobada').lastInsertRowid;
user('María Rivera', 'patrono@constructoracaribe.com', 'employer', c1, { phone: '787-555-0200' });
user('José Torres', 'patrono@smborinquen.com', 'employer', c2, { phone: '787-555-0300' });

const e = [
  user('Carlos Méndez', 'carlos@demo.com', 'employee', c1, { job: 'Aprendiz de electricista', hours: 24, phone: '787-555-1001' }),
  user('Ana López', 'empleado@demo.com', 'employee', c1, { job: 'Aprendiz de plomería', hours: 24, phone: '787-555-1002' }),
  user('Luis Ortiz', 'luis@demo.com', 'employee', c1, { job: 'Aprendiz de carpintería', hours: 24, phone: '787-555-1003' }),
  user('Gloria Santos', 'gloria@demo.com', 'employee', c2, { job: 'Asistente de facturación médica', hours: 16, phone: '787-555-1004' }),
  user('Pedro Colón', 'pedro@demo.com', 'employee', c2, { job: 'Técnico de récords médicos', hours: 16, phone: '787-555-1005' }),
];

const tr = (title, modality, startH, company, hours = 2, extra = {}) => db.prepare(`INSERT INTO trainings (title, description, modality, starts_at, due_at, duration_min, hours_credit, location, meeting_url, instructor, company_id, created_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, extra.desc || null, modality, at(startH), extra.dueH != null ? at(extra.dueH) : null, extra.min || hours * 60, hours, extra.loc || null, extra.url || null, extra.inst || 'Instructor certificado', company, admin).lastInsertRowid;

const t1 = tr('Seguridad OSHA 10 — Módulo 1', 'presencial', -24 * 6, c1, 4, { loc: 'Centro de Adiestramiento, Bayamón' });
const t2 = tr('Lectura de planos', 'zoom', -24 * 2, c1, 2, { url: 'https://zoom.us/j/123456789' });
const t3 = tr('Código eléctrico NEC — Introducción', 'video', -24, c1, 2, { url: process.env.SEED_VIDEO_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', dueH: 48, min: 10,
  desc: 'Video introductorio a la estructura del Código Eléctrico Nacional (NEC). Véalo completo y luego complete su progress report.' });
const t4 = tr('Seguridad OSHA 10 — Módulo 2', 'presencial', 26, c1, 4, { loc: 'Centro de Adiestramiento, Bayamón' });
const t5 = tr('HIPAA y confidencialidad', 'zoom', -24 * 3, c2, 2, { url: 'https://zoom.us/j/987654321' });
const t6 = tr('Codificación ICD-10 básica', 'zoom', 11, c2, 3, { url: 'https://zoom.us/j/555555555' });

const asg = (t, emp, status, extra = {}) => {
  const id = db.prepare('INSERT INTO assignments (training_id, employee_id, status, confirmed_at, confirmed_via, checked_in_at, checked_out_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(t, emp, status, extra.conf || null, extra.conf ? 'plataforma' : null, extra.in || null, extra.out || null, extra.done || null, at(-24 * 10)).lastInsertRowid;
  if (extra.report) db.prepare('INSERT INTO progress_reports (assignment_id, employee_id, summary, applied_how, rating, hours_reported) VALUES (?,?,?,?,?,?)')
    .run(id, emp, extra.report, 'Lo aplicaré en las tareas diarias del proyecto.', 5, 2);
  return id;
};
const done = (h) => ({ conf: at(h - 24), in: at(h), out: at(h + 2), done: at(h + 2), report: 'Aprendimos los procedimientos correctos y las normas de seguridad aplicables al trabajo.' });
for (const emp of e.slice(0, 3)) asg(t1, emp, 'completado', done(-24 * 6));
asg(t2, e[0], 'completado', done(-48));
asg(t2, e[1], 'pendiente_reporte', { conf: at(-60), in: at(-48), out: at(-46) });
const absent = asg(t2, e[2], 'ausente');
for (const emp of e.slice(0, 3)) asg(t3, emp, emp === e[0] ? 'en_curso' : 'asignado', emp === e[0] ? { conf: at(-5), in: at(-5) } : {});
db.prepare("INSERT INTO video_progress (assignment_id, duration_sec, intervals, watched_sec, pct, last_position, presence_checks, started_at, updated_at) SELECT a.id, 600, '[[0,270]]', 270, 45, 270, 1, ?, ? FROM assignments a WHERE a.training_id = ? AND a.employee_id = ?")
  .run(at(-5), at(-5), t3, e[0]);
for (const emp of e.slice(0, 3)) asg(t4, emp, 'asignado');
asg(t5, e[3], 'completado', done(-72));
asg(t5, e[4], 'completado', done(-72));
asg(t6, e[3], 'confirmado', { conf: at(-2) });
asg(t6, e[4], 'asignado');

db.prepare("INSERT INTO compliance_alerts (type, assignment_id, employee_id, company_id, message) VALUES ('ausencia',?,?,?,?)")
  .run(absent, e[2], c1, 'Luis Ortiz no asistió a "Lectura de planos".');

const exp = db.prepare('INSERT INTO expenses (company_id, training_id, category, description, vendor, amount, incurred_on, created_by) VALUES (?,?,?,?,?,?,?,?)');
exp.run(c1, t1, 'instructor', 'Instructor OSHA módulo 1', 'Safety Pro PR', 850, at(-24 * 6).slice(0, 10), admin);
exp.run(c1, t1, 'local', 'Alquiler de salón', 'Centro de Adiestramiento', 300, at(-24 * 6).slice(0, 10), admin);
exp.run(c1, t1, 'alimentos', 'Almuerzo participantes', 'Cafetería La Esquina', 95.5, at(-24 * 6).slice(0, 10), admin);
exp.run(null, null, 'plataforma', 'Licencia Zoom mensual', 'Zoom', 149.9, at(-24 * 15).slice(0, 10), admin);
exp.run(c2, t5, 'instructor', 'Facilitador HIPAA', 'Health Compliance Group', 600, at(-72).slice(0, 10), admin);

console.log(`Base de datos de demostración creada en ${dbPath}
Contraseña para todos: Portilla2026!
  Presidente (todo + gastos): admin@portillalaw.com
  Personal (sin gastos):      staff@portillalaw.com
  Personal designado gastos:  finanzas@portillalaw.com
  Patrono:                    patrono@constructoracaribe.com
  Empleado:                   empleado@demo.com`);
