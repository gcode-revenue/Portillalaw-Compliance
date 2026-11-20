'use strict';
process.env.DB_PATH = ':memory:';
process.env.ZOOM_ACCOUNT_ID = 'acc'; process.env.ZOOM_CLIENT_ID = 'cid'; process.env.ZOOM_CLIENT_SECRET = 'sec';
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const video = require('../src/services/video');
const zoom = require('../src/services/zoom');
const compliance = require('../src/services/compliance');

const H = 3600000, M = 60000;
const company = db.prepare("INSERT INTO companies (name) VALUES ('ACME')").run().lastInsertRowid;
db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin','admin@t.com','x','admin')").run();
const mkEmp = (name, email) => db.prepare("INSERT INTO users (name, email, phone, password_hash, role, company_id) VALUES (?,?,?,?, 'employee', ?)")
  .run(name, email, '787-555-0000', 'x', company).lastInsertRowid;
function videoAssignment(emp, { startOffset = -H, dueOffset = 48 * H } = {}) {
  const t = db.prepare("INSERT INTO trainings (title, modality, starts_at, due_at, duration_min, hours_credit, meeting_url) VALUES ('Video', 'video', ?, ?, 10, 1, 'https://youtu.be/dQw4w9WgXcQ')")
    .run(new Date(Date.now() + startOffset).toISOString(), new Date(Date.now() + dueOffset).toISOString()).lastInsertRowid;
  return db.prepare('INSERT INTO assignments (training_id, employee_id) VALUES (?,?)').run(t, emp).lastInsertRowid;
}
const status = (a) => db.prepare('SELECT status FROM assignments WHERE id = ?').get(a).status;

test('unión de tramos y detección de plataforma', () => {
  assert.deepStrictEqual(video.mergeIntervals([[0, 10], [5, 20], [30, 40], [40.5, 50]]), [[0, 20], [30, 50]]);
  assert.deepStrictEqual(video.parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'), { provider: 'youtube', id: 'dQw4w9WgXcQ' });
  assert.strictEqual(video.parseVideoUrl('https://vimeo.com/123456789/abcdef').hash, 'abcdef');
  assert.strictEqual(video.parseVideoUrl('https://cdn.x.com/a.mp4').provider, 'file');
});

test('video: ver al 90% completa; adelantar en masa no cuenta', () => {
  const emp = mkEmp('Ana', 'ana@t.com');
  const a = videoAssignment(emp);
  let now = Date.now();
  let r = video.recordProgress(a, emp, { duration: 600, intervals: [[0, 15]] }, now);
  assert.ok(r.ok); assert.strictEqual(r.pct, 2);
  assert.strictEqual(status(a), 'en_curso', 'primer avance = check-in automático');
  // Intento de acreditar 10 minutos en 15 segundos: rechazado
  r = video.recordProgress(a, emp, { duration: 600, intervals: [[15, 600]] }, now + 15000);
  assert.strictEqual(r.pct, 2);
  // Reproducción real en tramos de 15 s hasta el 90%
  for (let t = 15; t < 545; t += 15) { now += 15000; r = video.recordProgress(a, emp, { duration: 600, intervals: [[t, t + 15]] }, now); }
  assert.ok(r.pct >= 90, `pct ${r.pct}`);
  assert.ok(r.completed);
  assert.strictEqual(status(a), 'pendiente_reporte');
  assert.strictEqual(compliance.submitReport(a, emp, { summary: 'Aprendí los conceptos principales del video.' }).ok, true);
  assert.strictEqual(status(a), 'completado');
});

test('video: no disponible antes de la fecha, ni de otro empleado', () => {
  const emp = mkEmp('Luis', 'luis@t.com');
  const other = mkEmp('Otro', 'otro@t.com');
  const a = videoAssignment(emp, { startOffset: 2 * H });
  assert.strictEqual(video.recordProgress(a, emp, { duration: 600, intervals: [[0, 10]] }).ok, false);
  assert.strictEqual(video.recordProgress(a, other, { duration: 600, intervals: [[0, 10]] }).ok, false);
});

test('video: recordatorios antes de la fecha límite y ausencia si no lo completa', async () => {
  const emp = mkEmp('Pedro', 'pedro@t.com');
  const a = videoAssignment(emp, { dueOffset: 30 * H });
  const due = Date.now() + 30 * H;
  await compliance.tick(new Date(due - 23 * H));
  const keys = db.prepare("SELECT dedupe_key FROM notifications WHERE assignment_id = ? AND kind = 'recordatorio'").all(a).map((r) => r.dedupe_key);
  assert.ok(keys.some((k) => k.startsWith(`rem:${a}:1440`)), 'recordatorio de 24 h antes de la fecha límite');
  assert.ok(db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'sin_confirmar'").get(a), 'alerta: no ha comenzado el video');
  await compliance.tick(new Date(due + 20 * M));
  assert.strictEqual(status(a), 'ausente');
  assert.match(db.prepare("SELECT message FROM compliance_alerts WHERE assignment_id = ? AND type = 'ausencia'").get(a).message, /no completó el video/);
});

test('zoom: el reporte de participantes marca asistencia automáticamente', async () => {
  const e1 = mkEmp('María Rodríguez', 'maria@t.com');
  const e2 = mkEmp('José Pérez', 'jose@t.com');
  const e3 = mkEmp('Carmen Díaz', 'carmen@t.com');
  const start = Date.now() - 3 * H;
  const t = db.prepare("INSERT INTO trainings (title, modality, starts_at, duration_min, hours_credit, meeting_url) VALUES ('Zoom', 'zoom', ?, 60, 1, 'https://us02web.zoom.us/j/81234567890?pwd=abc')")
    .run(new Date(start).toISOString()).lastInsertRowid;
  const [a1, a2, a3] = [e1, e2, e3].map((e) => db.prepare('INSERT INTO assignments (training_id, employee_id) VALUES (?,?)').run(t, e).lastInsertRowid);
  const iso = (ms) => new Date(start + ms).toISOString();
  zoom._setFetch(async (url) => {
    if (url.includes('oauth/token')) return { ok: true, json: async () => ({ access_token: 'tk', expires_in: 3600 }) };
    assert.match(url, /report\/meetings\/81234567890\/participants/);
    return { ok: true, status: 200, json: async () => ({ participants: [
      { name: 'Maria Rodriguez', user_email: 'MARIA@t.com', join_time: iso(-2 * M), leave_time: iso(30 * M), duration: 32 * 60 },
      { name: 'Maria Rodriguez', user_email: 'maria@t.com', join_time: iso(31 * M), leave_time: iso(60 * M), duration: 29 * 60 },
      { name: 'jose perez', user_email: '', join_time: iso(0), leave_time: iso(20 * M), duration: 20 * 60 },
    ] }) };
  });
  const n = await zoom.syncTraining(db.prepare('SELECT * FROM trainings WHERE id = ?').get(t));
  assert.strictEqual(n, 1);
  const row = db.prepare('SELECT * FROM assignments WHERE id = ?').get(a1);
  assert.strictEqual(row.status, 'pendiente_reporte');
  assert.strictEqual(row.attendance_source, 'zoom');
  assert.strictEqual(row.attended_minutes, 61);
  assert.strictEqual(status(a2), 'asignado', '20 de 60 min no alcanza el 75%');
  assert.match(db.prepare('SELECT notes FROM assignments WHERE id = ?').get(a2).notes, /Conectado sólo 20/);
  // El motor espera el reporte de Zoom antes de marcar ausente, y luego decide
  await compliance.tick(new Date(start + 60 * M + 30 * M));
  assert.strictEqual(status(a3), 'asignado', 'espera por Zoom');
  await compliance.tick(new Date(start + 60 * M + 61 * M));
  assert.strictEqual(status(a3), 'ausente');
  assert.strictEqual(status(a1), 'pendiente_reporte');
});
