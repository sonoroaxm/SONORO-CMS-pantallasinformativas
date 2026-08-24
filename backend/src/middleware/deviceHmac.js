// VULN-003/006 — HMAC device auth (S185h)
// Modo default: log-only (HMAC_ENFORCE unset o != 'true').
// Devices con device_secret NULL → passthrough (grandfather).
// Devices con secret → verifica HMAC-SHA256; log warning si falla, bloquea solo si ENFORCE.

const crypto = require('crypto');

const ENFORCE = process.env.HMAC_ENFORCE === 'true';
const MAX_SKEW_SEC = 300;

module.exports = function makeDeviceHmac(pool) {
  return async function deviceHmac(req, res, next) {
    const deviceId = req.params?.device_id || req.body?.device_id || req.query?.device_id;
    if (!deviceId) return next();

    let secret = null;
    try {
      const { rows } = await pool.query('SELECT device_secret FROM devices WHERE device_id = $1', [deviceId]);
      secret = rows[0]?.device_secret || null;
    } catch (e) {
      console.error(`[HMAC] db error device=${deviceId}: ${e.message}`);
      return next();
    }

    if (!secret) return next();

    const sig = req.headers['x-device-signature'];
    const ts  = req.headers['x-device-timestamp'];

    if (!sig || !ts) {
      console.warn(`[HMAC] device=${deviceId} missing headers sig=${!!sig} ts=${!!ts} path=${req.path}`);
      if (ENFORCE) return res.status(401).json({ error: 'hmac_headers_missing' });
      return next();
    }

    const skew = Math.abs(Date.now() / 1000 - Number(ts));
    if (!Number.isFinite(skew) || skew > MAX_SKEW_SEC) {
      console.warn(`[HMAC] device=${deviceId} clock skew=${skew}s path=${req.path}`);
      if (ENFORCE) return res.status(401).json({ error: 'hmac_skew' });
      return next();
    }

    const body = req.rawBody || '';
    const payload = `${req.method}\n${req.path}\n${ts}\n${body}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    let ok = false;
    try {
      ok = sig.length === expected.length &&
           crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch (_) { ok = false; }

    if (!ok) {
      console.warn(`[HMAC] device=${deviceId} signature mismatch path=${req.path}`);
      if (ENFORCE) return res.status(401).json({ error: 'hmac_invalid' });
      return next();
    }

    req.deviceAuthenticated = true;
    next();
  };
};
