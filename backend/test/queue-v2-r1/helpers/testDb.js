'use strict';
// ── Shared test infrastructure for Queue v2 R1 integration/concurrency tests ──
const { Pool } = require('pg');
const jwt      = require('jsonwebtoken');

const JWT_SECRET = '5cf2c365324ed97e3d1df2c607d7f54fdc23dae27def6a6b57e8fd2af54f0d295f0a7b6a13ad54ea49fdace5ede63ce6b7fbcce2720ed91b1bb50425be534a5c';

// Production DB (same credentials as backend)
const pool = new Pool({
  host: 'localhost', port: 5432,
  database: 'cms_signage', user: 'sonoro_db', password: 'DBS@noro2026',
  max: 10,
});

// User id=12 (daniel@sonoro.com.co) — feature queue_v2_appointments: true
const USER_ID   = 12;
const BRANCH_ID = '826c0301-0b43-4736-8b58-d1d9e591ddde';
const SVC_ID    = 'ff32812b-f8b6-4529-a989-e271e438613f'; // Consulta General, price 60000 COP
const SVC_ID_2  = 'afee1075-50f4-4565-9498-4e43b21b0bf2'; // Procedimiento, price 150000 COP
const KIOSK_TK  = '3bdf121d-c9a5-427a-8b21-7ed7e1579c4b';
const API       = 'http://localhost:5000';

// JWT signed exactly like the backend signs tokens
const TOKEN = jwt.sign(
  { id: USER_ID, email: 'daniel@sonoro.com.co',
    features: { turnos: true, queue_v2_appointments: true } },
  JWT_SECRET, { expiresIn: '2h' }
);

function authHdr() {
  return { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
}

async function apiPost(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST', headers: authHdr(), body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function apiGet(path) {
  const r = await fetch(`${API}${path}`, { headers: authHdr() });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function apiPatch(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'PATCH', headers: authHdr(), body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ISO string for a test appointment: far future date, today+deltaDays at hh:mm UTC
function futureSlot(deltaDays = 30, hh = 14, mm = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + deltaDays);
  d.setUTCHours(hh, mm, 0, 0);
  return d.toISOString();
}

// Today in Bogotá at hh:mm UTC (Colombia = UTC-5, no DST)
function todayBogotaSlot(hh = 14) {
  // Bogotá at hh:00 → UTC hh+5:00
  const d = new Date();
  d.setUTCHours(hh + 5, 0, 0, 0);
  // If hh+5 wrapped past midnight UTC, adjust date back
  // (safe: tests always call at Bogotá business hours so hh+5 ≤ 28 → valid)
  return d.toISOString();
}

// Remove test appointments by id array
async function cleanAppts(ids) {
  if (!ids.length) return;
  // Also remove any queue_tokens linked to these appointments
  await pool.query(`DELETE FROM queue_tokens WHERE appointment_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM appointments WHERE id = ANY($1::uuid[])`, [ids]);
}

// Remove test time_blocks by id array
async function cleanBlocks(ids) {
  if (!ids.length) return;
  await pool.query(`DELETE FROM time_blocks WHERE id = ANY($1::int[])`, [ids]);
}

module.exports = {
  pool, TOKEN, BRANCH_ID, SVC_ID, SVC_ID_2, KIOSK_TK, API, USER_ID,
  authHdr, apiPost, apiGet, apiPatch, futureSlot, todayBogotaSlot,
  cleanAppts, cleanBlocks,
};
