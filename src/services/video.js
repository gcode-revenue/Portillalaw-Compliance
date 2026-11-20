'use strict';
// Seguimiento de videos: el navegador reporta los tramos que el empleado vio en
// reproducción normal. Adelantar el video NO cuenta. Al alcanzar el % mínimo,
// el entrenamiento pasa a "pendiente de progress report" automáticamente.
const { db, getSetting, audit } = require('../db');

/** Une tramos solapados: [[0,10],[5,20],[30,40]] -> [[0,20],[30,40]] */
function mergeIntervals(list) {
  const sorted = list.filter((x) => Array.isArray(x) && x.length === 2 && x[1] > x[0]).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
const covered = (list) => list.reduce((s, [a, b]) => s + (b - a), 0);

/** Detecta la plataforma del video a partir del enlace. */
function parseVideoUrl(url) {
  if (!url) return null;
  let m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(url);
  if (m) return { provider: 'youtube', id: m[1] };
  m = /vimeo\.com\/(?:video\/)?(\d+)(?:\/([\w]+))?/.exec(url);
  if (m) return { provider: 'vimeo', id: m[1], hash: m[2] || null, url };
  if (/\.(mp4|webm|m4v|mov)(\?|#|$)/i.test(url)) return { provider: 'file', url };
  return { provider: 'external', url };
}

function getProgress(assignmentId) {
  return db.prepare('SELECT * FROM video_progress WHERE assignment_id = ?').get(assignmentId) || null;
}

/** Ventana en la que el video puede verse: desde la fecha de inicio hasta la fecha límite. */
function videoWindow(t) {
  const open = new Date(t.starts_at).getTime();
  const close = t.due_at ? new Date(t.due_at).getTime() : open + t.duration_min * 60000;
  return { open, close };
}

/**
 * Registra progreso enviado por el reproductor.
 * body: { duration, intervals:[[a,b]...], position, presence }
 */
function recordProgress(assignmentId, employeeId, body, now = Date.now()) {
  const a = db.prepare(`SELECT a.*, t.modality, t.starts_at, t.due_at, t.duration_min, t.title FROM assignments a
    JOIN trainings t ON t.id = a.training_id WHERE a.id = ? AND a.employee_id = ? AND t.cancelled = 0`).get(assignmentId, employeeId);
  if (!a || a.modality !== 'video') return { ok: false, error: 'Asignación no encontrada.' };
  if (['ausente', 'excusado'].includes(a.status)) return { ok: false, error: 'Este entrenamiento ya está cerrado.' };
  const w = videoWindow(a);
  if (now < w.open) return { ok: false, error: 'El video todavía no está disponible.' };
  if (now > w.close && !['pendiente_reporte', 'completado'].includes(a.status)) return { ok: false, error: 'La fecha límite para este video ya pasó.' };

  const nowIso = new Date(now).toISOString();
  const prev = getProgress(assignmentId);
  const duration = Number(body.duration);
  const dur = prev?.duration_sec || (Number.isFinite(duration) && duration > 0 && duration < 24 * 3600 ? duration : null);
  if (!dur) return { ok: false, error: 'Duración del video desconocida.' };

  // Validar tramos y limitar lo que se puede acreditar según el tiempo real transcurrido
  const incoming = mergeIntervals((Array.isArray(body.intervals) ? body.intervals : []).slice(0, 500)
    .map(([x, y]) => [Math.max(0, Number(x)), Math.min(dur, Number(y))]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  const prevIntervals = prev ? JSON.parse(prev.intervals) : [];
  const elapsedSec = prev?.updated_at ? (now - new Date(prev.updated_at).getTime()) / 1000 : 60;
  const maxNew = elapsedSec * 2.1 + 10; // tolera reproducción hasta 2x
  let merged = mergeIntervals([...prevIntervals, ...incoming]);
  if (covered(merged) - covered(prevIntervals) > maxNew) {
    // Más contenido del físicamente posible: sólo se acredita lo que ya estaba
    merged = prevIntervals;
    audit(employeeId, 'video_progreso_rechazado', 'assignment', assignmentId, { elapsedSec: Math.round(elapsedSec) });
  }
  const watched = Math.min(covered(merged), dur);
  const pct = Math.min(100, Math.floor((watched / dur) * 100));
  const minPct = Number(getSetting('video_min_pct'));
  const presence = Math.max(prev?.presence_checks || 0, Math.min(Number(body.presence) || 0, 1000));
  const completedNow = pct >= minPct && !prev?.completed_at;

  db.prepare(`INSERT INTO video_progress (assignment_id, duration_sec, intervals, watched_sec, pct, last_position, presence_checks, started_at, completed_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(assignment_id) DO UPDATE SET duration_sec=excluded.duration_sec, intervals=excluded.intervals, watched_sec=excluded.watched_sec,
      pct=excluded.pct, last_position=excluded.last_position, presence_checks=excluded.presence_checks,
      completed_at=COALESCE(video_progress.completed_at, excluded.completed_at), updated_at=excluded.updated_at`)
    .run(assignmentId, dur, JSON.stringify(merged), watched, pct, Number(body.position) || 0, presence,
      prev?.started_at || nowIso, completedNow ? nowIso : null, nowIso);

  // Primer avance real = check-in automático
  if (!a.checked_in_at && watched > 0) {
    db.prepare(`UPDATE assignments SET status = CASE WHEN status IN ('asignado','confirmado') THEN 'en_curso' ELSE status END,
      checked_in_at = ?, confirmed_at = COALESCE(confirmed_at, ?), confirmed_via = COALESCE(confirmed_via, 'video'), attendance_source = 'video' WHERE id = ?`)
      .run(nowIso, nowIso, assignmentId);
    db.prepare("UPDATE compliance_alerts SET status='resuelta', resolution='El empleado comenzó el video', resolved_at=? WHERE assignment_id=? AND type='sin_confirmar' AND status='abierta'").run(nowIso, assignmentId);
  }
  if (completedNow) {
    const hasReport = !!db.prepare('SELECT 1 FROM progress_reports WHERE assignment_id = ?').get(assignmentId);
    db.prepare(`UPDATE assignments SET status = ?, checked_out_at = ?, attended_minutes = ?, completed_at = CASE WHEN ? = 'completado' THEN ? ELSE completed_at END WHERE id = ?`)
      .run(hasReport ? 'completado' : 'pendiente_reporte', nowIso, Math.round(watched / 60), hasReport ? 'completado' : '', nowIso, assignmentId);
    audit(employeeId, 'video_completado', 'assignment', assignmentId, { pct });
  }
  return { ok: true, pct, minPct, watched: Math.round(watched), duration: dur, completed: pct >= minPct, justCompleted: completedNow, intervals: merged };
}

module.exports = { mergeIntervals, covered, parseVideoUrl, getProgress, recordProgress, videoWindow };
