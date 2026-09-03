// LICENSES-V1 — Approval service (Fase 2)
// JWT one-shot 24h + Google OAuth code flow manual (sin google-auth-library, usa fetch nativo Node 20).
// Framework: docs/LICENSES-V1.md §aprobación email.

'use strict';
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

const APP_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';
const WHITELIST = (process.env.LICENSE_APPROVAL_WHITELIST || 'sonoroaxm@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || `${APP_URL}/api/auth/google/callback`;

// ── JWT one-shot ─────────────────────────────────────────────────────────────
// Emite JWT con jti aleatorio y persiste jti en license_orders.approval_token_jti.
// Verificar consume jti (approval_token_used_at) => single-use.

// approval_token_jti almacena JSON: {"approve":"<jti>","reject":"<jti>"}.
// Es TEXT UNIQUE en el schema, así que sirve el string JSON directo (único por orden).
async function _loadJtis(pool, orderId) {
  const r = await pool.query(
    `SELECT approval_token_jti FROM license_orders WHERE id = $1`, [orderId]);
  if (!r.rows[0]) return null;
  const raw = r.rows[0].approval_token_jti;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function issueApprovalToken(pool, orderId, action) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { orderId, action, jti }, process.env.JWT_SECRET, { expiresIn: '24h' });
  const current = (await _loadJtis(pool, orderId)) || {};
  current[action] = jti;
  await pool.query(
    `UPDATE license_orders
        SET approval_token_jti = $1, approval_token_used_at = NULL
      WHERE id = $2`,
    [JSON.stringify(current), orderId]);
  return token;
}

async function verifyApprovalToken(pool, token, expectedAction) {
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return { ok: false, error: 'Token inválido o expirado' }; }
  if (payload.action !== expectedAction) return { ok: false, error: 'Acción no coincide' };
  const r = await pool.query(
    `SELECT id, status, approval_token_jti, approval_token_used_at
       FROM license_orders WHERE id = $1`, [payload.orderId]);
  if (!r.rows[0]) return { ok: false, error: 'Orden no encontrada' };
  const row = r.rows[0];
  if (row.approval_token_used_at) return { ok: false, error: 'Token ya usado' };
  let jtis = {};
  try { jtis = JSON.parse(row.approval_token_jti || '{}'); } catch {}
  if (jtis[payload.action] !== payload.jti) return { ok: false, error: 'Token revocado' };
  return { ok: true, orderId: payload.orderId, action: payload.action };
}

async function consumeApprovalToken(pool, orderId) {
  await pool.query(
    `UPDATE license_orders SET approval_token_used_at = NOW() WHERE id = $1`,
    [orderId]
  );
}

// ── Google OAuth (code flow manual) ──────────────────────────────────────────

function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchUserInfo(accessToken) {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`userinfo failed: ${r.status}`);
  return r.json();
}

function isApprover(email) {
  return !!email && WHITELIST.includes(email.toLowerCase());
}

// ── State (para CSRF/next) firmado como JWT corto ────────────────────────────
function signState(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '10m' });
}
function verifyState(state) {
  try { return jwt.verify(state, process.env.JWT_SECRET); }
  catch { return null; }
}

module.exports = {
  issueApprovalToken,
  verifyApprovalToken,
  consumeApprovalToken,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  isApprover,
  signState,
  verifyState,
  WHITELIST,
};
