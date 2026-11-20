'use strict';
process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert');
const { db } = require('../src/db');
const compliance = require('../src/services/compliance');
const { employeeProgress } = require('../src/services/progress');
const { makeToken, verifyToken } = require('../src/util/tokens');
const { canSeeExpenses } = require('../src/auth');
const { localInputToIso, isoToLocalInput } = require('../src/util/time');

const H = 3600000, M = 60000;
const company = db.prepare("INSERT INTO companies (name) VALUES ('ACME PR')").run().lastInsertRowid;
const mkUser = (name, role, extra = {}) => db.prepare('INSERT INTO users (name, email, phone, password_hash, role, company_id) VALUES (?,?,?,?,?,?)')
  .run(name, `${name}@t.com`, '787-555-0000', 'x', role, extra.company ?? null).lastInsertRowid;
mkUser('admin', 'admin');
mkUser('patrono', 'employer', { company });

function scenario(name, startOffsetMs, duration = 60) {
  const emp = mkUser(name, 'employee', { company });
  const start = new Date(Date.now() + startOffsetMs);
  const t = db.prepare("INSERT INTO trainings (title, modality, starts_at, duration_min, hours_credit) VALUES (?, 'zoom', ?, ?, 2)")
    .run(`T-${name}`, start.toISOString(), duration).lastInsertRowid;
  const a = db.prepare('INSERT INTO assignments (training_id, employee_id) VALUES (?,?)').run(t, emp).lastInsertRowid;
  return { emp, start, a };
}
const sent = (a, prefix) => db.prepare("SELECT dedupe_key FROM notifications WHERE assignment_id = ? AND dedupe_key LIKE ? ").all(a, prefix + '%').map((r) => r.dedupe_key);
const status = (a) => db.prepare('SELECT status FROM assignments WHERE id = ?').get(a).status;

test('recordatorios 24h, 12h, 1h, 30m, 5m sin duplicados', async () => {
  const { a, start } = scenario('rem', 30 * H);
  const at = (ms) => new Date(start.getTime() - ms);
  await compliance.tick(at(25 * H));
  assert.deepStrictEqual(sent(a, 'rem:'), []);
  await compliance.tick(at(24 * H - M));
  await compliance.tick(at(24 * H - 2 * M));
  assert.deepStrictEqual(sent(a, `rem:${a}:1440:email`).length, 1, 'un solo email de 24h');
  for (const off of [720, 60, 30, 5]) await compliance.tick(at(off * M - M));
  const keys = new Set(sent(a, 'rem:').map((k) => k.split(':')[2]));
  assert.deepStrictEqual([...keys].sort((x, y) => y - x), ['1440', '720', '60', '30', '5']);
  // email + sms por cada recordatorio
  assert.strictEqual(sent(a, 'rem:').length, 10);
});

test('sin check-in => AUSENTE, alerta y aviso a staff, patrono y empleado', async () => {
  const { a, start, emp } = scenario('ausente', 2 * H);
  await compliance.tick(new Date(start.getTime() + 60 * M + 20 * M));
  assert.strictEqual(status(a), 'ausente');
  assert.ok(db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'ausencia'").get(a));
  assert.ok(sent(a, `abs:${a}`).length >= 1, 'staff notificado');
  assert.ok(sent(a, `abs-emp:${a}`).length >= 1, 'patrono notificado');
  assert.ok(sent(a, `abs-ee:${a}`).length >= 1, 'empleado notificado');
  assert.strictEqual(employeeProgress(emp).inCompliance, false);
});

test('check-in + progress report => completado y gauge al 100%', async () => {
  const { a, start, emp } = scenario('ok', 2 * H);
  assert.ok(compliance.confirmAssignment(a, 'test'));
  assert.strictEqual(compliance.checkIn(a, start.getTime() - 60 * M).ok, false, 'check-in aún cerrado');
  assert.strictEqual(compliance.checkIn(a, start.getTime() + 5 * M).ok, true);
  await compliance.tick(new Date(start.getTime() + 80 * M));
  assert.strictEqual(status(a), 'pendiente_reporte');
  assert.ok(sent(a, `rep:${a}:0`).length >= 1, 'se solicitó el progress report');
  assert.strictEqual(compliance.submitReport(a, emp, { summary: 'corto' }).ok, false);
  assert.strictEqual(compliance.submitReport(a, emp, { summary: 'Aprendí a leer los planos eléctricos del proyecto.' }).ok, true);
  assert.strictEqual(status(a), 'completado');
  const p = employeeProgress(emp);
  assert.strictEqual(p.pct, 100);
  assert.strictEqual(p.inCompliance, true);
});

test('progress report vencido => alerta sin_reporte', async () => {
  const { a, start } = scenario('tarde', 2 * H);
  compliance.checkIn(a, start.getTime());
  await compliance.tick(new Date(start.getTime() + 80 * M));
  await compliance.tick(new Date(start.getTime() + 60 * M + 25 * H));
  assert.ok(!db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'sin_reporte'").get(a));
  await compliance.tick(new Date(start.getTime() + 60 * M + 49 * H));
  await compliance.tick(new Date(start.getTime() + 60 * M + 73 * H));
  assert.ok(db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'sin_reporte'").get(a));
  assert.deepStrictEqual(new Set(sent(a, `rep:${a}:`).map((k) => k.split(':')[2])), new Set(['0', '24', '48']));
});

test('sin confirmar a 24h => alerta; a 12h => aviso al patrono', async () => {
  const { a, start } = scenario('noconf', 48 * H);
  await compliance.tick(new Date(start.getTime() - 23 * H));
  assert.ok(db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'sin_confirmar' AND status = 'abierta'").get(a));
  assert.strictEqual(sent(a, `unc-emp:${a}`).length, 0);
  await compliance.tick(new Date(start.getTime() - 11 * H));
  assert.ok(sent(a, `unc-emp:${a}`).length >= 1);
  compliance.confirmAssignment(a, 'sms');
  assert.ok(db.prepare("SELECT 1 FROM compliance_alerts WHERE assignment_id = ? AND type = 'sin_confirmar' AND status = 'resuelta'").get(a));
});

test('enlaces firmados', () => {
  const t = makeToken('confirm', 42);
  assert.deepStrictEqual(verifyToken(t), { action: 'confirm', assignmentId: 42 });
  assert.strictEqual(verifyToken(t.replace('.42.', '.43.')), null);
  assert.strictEqual(verifyToken(makeToken('confirm', 1, -1)), null);
});

test('gastos: sólo presidente o personal designado', () => {
  assert.ok(canSeeExpenses({ role: 'admin' }));
  assert.ok(canSeeExpenses({ role: 'staff', can_view_expenses: 1 }));
  assert.ok(!canSeeExpenses({ role: 'staff', can_view_expenses: 0 }));
  assert.ok(!canSeeExpenses({ role: 'employer', can_view_expenses: 1 }));
  assert.ok(!canSeeExpenses({ role: 'employee' }));
});

test('hora de Puerto Rico', () => {
  assert.strictEqual(localInputToIso('2026-11-20T14:30'), '2026-11-20T18:30:00.000Z');
  assert.strictEqual(isoToLocalInput('2026-11-20T18:30:00.000Z'), '2026-11-20T14:30');
});

test('la bitácora registra el resultado del envío (simulado sin credenciales)', async () => {
  const { notifyUser } = require('../src/services/notify');
  const u = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  const r = await notifyUser(u, { kind: 'prueba', subject: 's', text: 't' });
  assert.deepStrictEqual(r.map((x) => x.status), ['simulado', 'simulado']);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM notifications WHERE status = 'pendiente'").get().c, 0);
});
