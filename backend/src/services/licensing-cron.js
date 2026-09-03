// LICENSES-V1 — Cron jobs (§6.5)
// Fase: 1c-ii.
//
// 3 jobs (todos idempotentes):
//   1) Diario 03:00 America/Bogota  → active → expired si end_date < NOW()
//   2) Diario 09:00 America/Bogota  → marca notificaciones pendientes 30d/7d
//      (envío real de email queda para Fase 2 con Google OAuth + mailer real;
//       aquí solo se registra en audit para no perder eventos)
//   3) Cada hora                   → cancela órdenes pending_payment > 7 días
//
// Implementación: setInterval simple + guard "ya corrió esta hora/día".
// Tolerante a arranques múltiples (marca de última corrida en tabla o memoria).

'use strict';
const mailer = require('./licensing-mailer');

const TICK_MS = 5 * 60 * 1000; // Chequeo cada 5 minutos qué toca ejecutar

function nowInBogota() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota', hour12: false });
  return new Date(s);
}

async function expireLicenses(pool) {
  const r = await pool.query(
    `UPDATE licenses SET status = 'expired'
      WHERE status = 'active' AND end_date < NOW()
      RETURNING id, user_id, product, end_date`
  );
  if (r.rowCount > 0) console.log(`[licenses-cron] expired ${r.rowCount} licencias`);
  return r.rowCount;
}

async function markExpiringNotifications(pool) {
  // Registra en audit las licencias que entran a ventana 30d/7d (sin duplicar el día).
  // Email real: Fase 2.
  const q = await pool.query(`
    WITH expiring AS (
      SELECT l.id, l.user_id, l.product, l.end_date,
             CEIL(EXTRACT(EPOCH FROM (l.end_date - NOW()))/86400)::int AS days_left,
             u.email, u.name
        FROM licenses l
        JOIN users u ON u.id = l.user_id
       WHERE l.status = 'active'
         AND l.end_date BETWEEN NOW() AND NOW() + INTERVAL '30 days'
    )
    SELECT id, user_id, product, end_date, days_left, email, name
      FROM expiring
     WHERE days_left IN (30, 7)`
  );
  for (const row of q.rows) {
    mailer.notifyClientLicenseExpiring({
      license: { id: row.id, product: row.product, end_date: row.end_date },
      user: { id: row.user_id, email: row.email, name: row.name },
      daysLeft: row.days_left,
    });
  }
  if (q.rows.length) {
    console.log(`[licenses-cron] notificadas ${q.rows.length} licencias ventana 30d/7d`);
  }
  return q.rows.length;
}

async function cancelStaleOrders(pool) {
  const r = await pool.query(
    `UPDATE license_orders
        SET status = 'cancelled',
            admin_note = COALESCE(admin_note,'') || ' [auto-cancel: pending>7d]'
      WHERE status = 'pending_payment'
        AND created_at < NOW() - INTERVAL '7 days'
      RETURNING id`
  );
  if (r.rowCount > 0) {
    console.log(`[licenses-cron] canceladas ${r.rowCount} órdenes pending_payment >7d`);
    for (const row of r.rows) {
      await pool.query(
        `INSERT INTO license_order_audit (order_id, action, actor_email, metadata)
         VALUES ($1, 'auto_cancelled', 'system@sonoro', $2)`,
        [row.id, JSON.stringify({ reason: 'pending_payment > 7 days' })]
      );
    }
  }
  return r.rowCount;
}

function start(pool) {
  const state = { lastExpireDay: null, lastNotifyDay: null, lastCancelHour: null };

  async function tick() {
    try {
      const bogota = nowInBogota();
      const dayKey  = bogota.toISOString().slice(0,10);
      const hour    = bogota.getHours();
      const hourKey = `${dayKey}T${hour}`;

      if (hour === 3 && state.lastExpireDay !== dayKey) {
        state.lastExpireDay = dayKey;
        await expireLicenses(pool);
      }
      if (hour === 9 && state.lastNotifyDay !== dayKey) {
        state.lastNotifyDay = dayKey;
        await markExpiringNotifications(pool);
      }
      if (state.lastCancelHour !== hourKey) {
        state.lastCancelHour = hourKey;
        await cancelStaleOrders(pool);
      }
    } catch (err) {
      console.error('[licenses-cron] tick error:', err.message);
    }
  }

  // Kick-off inmediato (no espera 5min al startup)
  tick();
  const handle = setInterval(tick, TICK_MS);
  console.log('[licenses-cron] iniciado (tick 5min, TZ America/Bogota)');
  return handle;
}

module.exports = { start, expireLicenses, markExpiringNotifications, cancelStaleOrders };
