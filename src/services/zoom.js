'use strict';
// Asistencia automática por Zoom. Al terminar una reunión, consulta el reporte de
// participantes de Zoom (API Server-to-Server OAuth) y marca presente a cada
// empleado que estuvo conectado el % mínimo de la duración.
// Requiere cuenta Zoom Pro o superior y una app "Server-to-Server OAuth" con el
// permiso report:read:list_meeting_participants:admin (o report:read:admin).
const { db, getSetting, audit } = require('../db');

let fetchImpl = (...args) => fetch(...args);
let token = null;

function configured() {
  return !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
}

function meetingIdFrom(t) {
  if (t.zoom_meeting_id) return String(t.zoom_meeting_id).replace(/\D/g, '');
  const m = /zoom\.us\/(?:j|s|w|wc\/join|my)\/(\d{9,12})/.exec(t.meeting_url || '');
  return m ? m[1] : null;
}

async function getToken() {
  if (token && token.exp > Date.now() + 60000) return token.value;
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetchImpl(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`,
    { method: 'POST', headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Zoom OAuth ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function fetchParticipants(meetingId) {
  const all = [];
  let next = '';
  const tk = await getToken();
  for (let page = 0; page < 20; page++) {
    const url = `https://api.zoom.us/v2/report/meetings/${meetingId}/participants?page_size=300${next ? `&next_page_token=${encodeURIComponent(next)}` : ''}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${tk}` } });
    if (res.status === 404) return null; // el reporte aún no está listo
    if (!res.ok) throw new Error(`Zoom reporte ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    all.push(...(j.participants || []));
    next = j.next_page_token;
    if (!next) break;
  }
  return all;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/** Calcula minutos conectados por empleado (por email; si no hay, por nombre). */
function matchAttendance(participants, employees, windowStart, windowEnd) {
  const result = new Map();
  for (const e of employees) result.set(e.id, { minutes: 0, first: null, last: null });
  for (const p of participants) {
    const join = new Date(p.join_time).getTime();
    if (Number.isFinite(join) && (join < windowStart || join > windowEnd)) continue; // otra sesión de una reunión recurrente
    const email = norm(p.user_email);
    const name = norm(p.name);
    const emp = employees.find((e) => email && norm(e.email) === email) || employees.find((e) => name && norm(e.name) === name);
    if (!emp) continue;
    const r = result.get(emp.id);
    r.minutes += (Number(p.duration) || 0) / 60;
    if (p.join_time && (!r.first || p.join_time < r.first)) r.first = p.join_time;
    if (p.leave_time && (!r.last || p.leave_time > r.last)) r.last = p.leave_time;
  }
  return result;
}

/** Sincroniza un entrenamiento de Zoom. Devuelve cuántos empleados quedaron presentes. */
async function syncTraining(t, now = Date.now()) {
  const meetingId = meetingIdFrom(t);
  if (!configured() || !meetingId) return null;
  const nowIso = new Date(now).toISOString();
  db.prepare(`INSERT INTO zoom_sync (training_id, last_attempt_at) VALUES (?, ?)
    ON CONFLICT(training_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`).run(t.id, nowIso);
  let participants;
  try {
    participants = await fetchParticipants(meetingId);
  } catch (e) {
    db.prepare('UPDATE zoom_sync SET error = ? WHERE training_id = ?').run(e.message, t.id);
    return null;
  }
  if (!participants) { db.prepare("UPDATE zoom_sync SET error = 'Reporte de Zoom aún no disponible' WHERE training_id = ?").run(t.id); return null; }

  const start = new Date(t.starts_at).getTime();
  const end = start + t.duration_min * 60000;
  const rows = db.prepare(`SELECT a.id aid, a.status, a.checked_in_at, u.id, u.name, u.email FROM assignments a JOIN users u ON u.id = a.employee_id
    WHERE a.training_id = ? AND a.status IN ('asignado','confirmado','en_curso','pendiente_reporte','completado','ausente')`).all(t.id);
  const att = matchAttendance(participants, rows, start - 60 * 60000, end + 60 * 60000);
  const minMinutes = t.duration_min * Number(getSetting('zoom_min_attendance_pct')) / 100;
  let present = 0;
  for (const r of rows) {
    const a = att.get(r.id);
    if (!a || a.minutes <= 0) continue;
    const minutes = Math.round(a.minutes);
    db.prepare('UPDATE assignments SET attended_minutes = ? WHERE id = ?').run(minutes, r.aid);
    if (a.minutes < minMinutes) {
      db.prepare("UPDATE assignments SET notes = COALESCE(notes || char(10), '') || ? WHERE id = ? AND (notes IS NULL OR notes NOT LIKE '%[Zoom]%')")
        .run(`[Zoom] Conectado sólo ${minutes} de ${t.duration_min} min (mínimo ${Math.round(minMinutes)}).`, r.aid);
      continue;
    }
    present++;
    if (['completado', 'pendiente_reporte'].includes(r.status) && r.checked_in_at) continue;
    const hasReport = !!db.prepare('SELECT 1 FROM progress_reports WHERE assignment_id = ?').get(r.aid);
    const newStatus = hasReport ? 'completado' : now >= end ? 'pendiente_reporte' : 'en_curso';
    db.prepare(`UPDATE assignments SET status = ?, checked_in_at = COALESCE(checked_in_at, ?), checked_out_at = COALESCE(checked_out_at, ?),
      confirmed_at = COALESCE(confirmed_at, ?), confirmed_via = COALESCE(confirmed_via, 'zoom'), attendance_source = 'zoom' WHERE id = ?`)
      .run(newStatus, a.first || nowIso, a.last || new Date(end).toISOString(), a.first || nowIso, r.aid);
    db.prepare(`UPDATE compliance_alerts SET status='resuelta', resolution='Asistencia verificada en el reporte de Zoom', resolved_at=?
      WHERE assignment_id=? AND type IN ('ausencia','sin_confirmar') AND status='abierta'`).run(nowIso, r.aid);
    audit(null, 'asistencia_zoom', 'assignment', r.aid, { minutes });
  }
  db.prepare('UPDATE zoom_sync SET synced_at = ?, participants = ?, error = NULL WHERE training_id = ?').run(nowIso, participants.length, t.id);
  return present;
}

/** Pasada del motor: entrenamientos Zoom terminados en las últimas 24 h, cada 10 min. */
async function syncPending(now = Date.now()) {
  if (!configured()) return 0;
  const list = db.prepare(`SELECT t.*, z.last_attempt_at, z.synced_at FROM trainings t LEFT JOIN zoom_sync z ON z.training_id = t.id
    WHERE t.modality = 'zoom' AND t.cancelled = 0`).all();
  let n = 0;
  for (const t of list) {
    const end = new Date(t.starts_at).getTime() + t.duration_min * 60000;
    if (now < end + 5 * 60000 || now > end + 24 * 3600000) continue;
    if (t.synced_at && new Date(t.synced_at).getTime() > end + 30 * 60000) continue; // ya tenemos el reporte final
    if (t.last_attempt_at && now - new Date(t.last_attempt_at).getTime() < 10 * 60000) continue;
    await syncTraining(t, now);
    n++;
  }
  return n;
}

module.exports = { configured, meetingIdFrom, matchAttendance, syncTraining, syncPending, _setFetch: (f) => { fetchImpl = f; token = null; } };
