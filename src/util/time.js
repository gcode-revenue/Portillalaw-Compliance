'use strict';
// Todas las fechas se guardan en ISO UTC y se muestran en hora de Puerto Rico.
const TZ = process.env.APP_TZ || 'America/Puerto_Rico';

function nowIso(now = new Date()) { return new Date(now).toISOString(); }
function addMin(date, min) { return new Date(new Date(date).getTime() + min * 60000); }

// Offset (min) del huso horario para una fecha dada (PR = -240 todo el año).
function tzOffsetMin(date = new Date(), tz = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// "2026-11-20T14:30" (hora local PR de un <input type=datetime-local>) -> ISO UTC
function localInputToIso(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = tzOffsetMin(new Date(guess));
  return new Date(guess - off * 60000).toISOString();
}

// ISO UTC -> valor para <input type=datetime-local> en hora PR
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const local = new Date(d.getTime() + tzOffsetMin(d) * 60000);
  return local.toISOString().slice(0, 16);
}

function fmt(iso, opts = {}) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('es-PR', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short', ...opts }).format(new Date(iso));
}
function fmtDate(iso) { return iso ? new Intl.DateTimeFormat('es-PR', { timeZone: TZ, dateStyle: 'medium' }).format(new Date(iso)) : '—'; }

function humanOffset(min) {
  if (min >= 1440 && min % 1440 === 0) return `${min / 1440 * 24} horas`;
  if (min >= 60 && min % 60 === 0) return min === 60 ? '1 hora' : `${min / 60} horas`;
  return `${min} minutos`;
}

module.exports = { TZ, nowIso, addMin, tzOffsetMin, localInputToIso, isoToLocalInput, fmt, fmtDate, humanOffset };
