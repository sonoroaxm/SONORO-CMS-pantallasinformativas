// S210-exec #3 — Events v1 access gate (dual: feature flag + events.licenses)
//
// AISLAMIENTO: consulta exclusivamente events.licenses. NUNCA public.licenses
// (ver docs/CLAUDE.md §Regla dura · docs/EVENTS-FRAMEWORK.md §0.1).
//
// Decisiones firmadas Daniel 13-oct-2026 (project_s210_exec_events_gate.md):
//   D-A grace     → tratar como active (acceso completo)
//   D-B readonly  → GET pasa, mutaciones → 423 Locked
//   D-C role=admin→ bypass total (sin consultar features ni licencias)
//   D-D sin licencia activa → 403 license_required (NUNCA auto-provisionar)
//
// Montaje (index.js):
//   const requireEventsAccess = require('./middleware/requireEventsAccess')(pool);
//   app.use('/api/events/calendar', requireEventsAccess, eventsCalendarRouter);
//   app.use('/api/events',          requireEventsAccess, eventsRouter);
//
// Excepciones mount-level:
//   /api/events/public  (registro público / token producción) — NO gatear
//   /api/events/staff   (PIN staff, no JWT)                  — NO gatear

'use strict';

const jwt = require('jsonwebtoken');

const SAFE_PATHS = new Set(['/health']);

module.exports = (pool) => async function requireEventsAccess(req, res, next) {
  try {
    if (SAFE_PATHS.has(req.path)) return next();

    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    let user;
    try { user = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(403).json({ error: 'Token inválido' }); }
    req.user = user;

    if (user.role === 'admin') return next();

    if (user.features?.events_v1 !== true) {
      return res.status(403).json({
        error: 'Events no está activo en tu cuenta.',
        code: 'EVENTS_FEATURE_OFF'
      });
    }

    const { rows } = await pool.query(
      `SELECT status FROM events.licenses
        WHERE user_id = $1 AND status IN ('active','grace','readonly')
        ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: 'Se requiere una licencia activa de Events.',
        code: 'EVENTS_NO_LICENSE'
      });
    }

    if (rows[0].status === 'readonly' && req.method !== 'GET') {
      return res.status(423).json({
        error: 'Tu licencia está en modo lectura. Renová para volver a editar.',
        code: 'EVENTS_LICENSE_READONLY'
      });
    }

    return next();
  } catch (err) {
    console.error('❌ requireEventsAccess:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
};
