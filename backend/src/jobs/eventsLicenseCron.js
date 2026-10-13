// S210-exec #6 + #7 — Cron Events licenses (reset mensual + grace/readonly/archive/wipe)
// Aislamiento duro: SOLO events.* — NUNCA public.licenses (docs/CLAUDE.md §Regla dura).
// Ventanas definidas en docs/PRICING-EVENTS-v1.md §5 (trial 30d + 12h wipe) y §6 (grace 15d / readonly 15d / archive 30d / wipe).

'use strict';

const { withTransaction } = require('../db/withTransaction');

const PAID_TIERS = ['lite', 'pro', 'masivo'];

async function resetMonthlyCounters(pool) {
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM
  const { rowCount } = await pool.query(
    `UPDATE events.licenses
        SET metadata = jsonb_set(
              jsonb_set(COALESCE(metadata, '{}'::jsonb), '{usage}',
                        '{"events":0,"attendees":0,"emails":0}'::jsonb, true),
              '{usage,period_start}', to_jsonb($1::text), true),
            updated_at = NOW()
      WHERE tier = ANY($2::text[])
        AND status IN ('active','grace','readonly')
        AND COALESCE(metadata->'usage'->>'period_start', '') <> $1`,
    [period, PAID_TIERS]
  );
  if (rowCount) console.log(`✅ cron.events_license.counters_reset period=${period} rows=${rowCount}`);
  return rowCount;
}

async function wipeTenant(client, user_id) {
  const ops = [
    `DELETE FROM events.service_redemptions WHERE registration_id IN (SELECT id FROM events.registrations WHERE user_id=$1)`,
    `DELETE FROM events.registration_checkins WHERE registration_id IN (SELECT id FROM events.registrations WHERE user_id=$1)`,
    `DELETE FROM events.registration_action_tokens WHERE registration_id IN (SELECT id FROM events.registrations WHERE user_id=$1)`,
    `DELETE FROM events.registration_sessions WHERE registration_id IN (SELECT id FROM events.registrations WHERE user_id=$1)`,
    `DELETE FROM events.registrations WHERE user_id=$1`,
    `DELETE FROM events.registration_invitation_batches WHERE user_id=$1`,
    `DELETE FROM events.production_tokens WHERE user_id=$1`,
    `DELETE FROM events.rundown_cues WHERE event_id IN (SELECT id FROM events.events WHERE user_id=$1)`,
    `DELETE FROM events.event_sessions WHERE user_id=$1`,
    `DELETE FROM events.event_calendar_sync WHERE user_id=$1`,
    `DELETE FROM events.event_staff WHERE user_id=$1`,
    `DELETE FROM events.event_suppliers WHERE user_id=$1`,
    `DELETE FROM events.supplier_quotes WHERE user_id=$1`,
    `DELETE FROM events.supplier_invite_tokens WHERE user_id=$1`,
    `DELETE FROM events.suppliers WHERE user_id=$1`,
    `DELETE FROM events.events WHERE user_id=$1`,
    `DELETE FROM events.attendees WHERE user_id=$1`,
    `DELETE FROM events.calendar_connect_tokens WHERE user_id=$1`,
    `DELETE FROM events.calendar_integrations WHERE user_id=$1`,
    `DELETE FROM events.calendar_watch_channels WHERE user_id=$1`,
    `DELETE FROM events.staff_catalog WHERE user_id=$1`,
  ];
  for (const q of ops) await client.query(q, [user_id]);
  await client.query(
    `UPDATE events.licenses
        SET status='cancelled',
            metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{wiped_at}', to_jsonb(NOW()::text), true),
            cancelled_at = NOW(),
            updated_at = NOW()
      WHERE user_id=$1 AND (
              (tier='trial' AND status IN ('active','archive')) OR
              (tier<>'trial' AND status='archive')
            )`,
    [user_id]
  );
}

async function transitionLicenseStates(pool) {
  const summary = { trial_wipe: 0, to_grace: 0, to_readonly: 0, to_archive: 0, archive_wipe: 0 };

  // 1) Trial wipe — trial active con end_date + 12h vencido
  const trialWipe = await pool.query(
    `SELECT user_id FROM events.licenses
      WHERE tier='trial' AND status='active' AND end_date < NOW() - INTERVAL '12 hours'`
  );
  for (const row of trialWipe.rows) {
    try {
      await withTransaction(pool, (c) => wipeTenant(c, row.user_id));
      summary.trial_wipe++;
      console.log(`✅ cron.events_license.trial_wipe user=${row.user_id}`);
    } catch (e) {
      console.error(`❌ cron.events_license.trial_wipe user=${row.user_id}:`, e.message);
    }
  }

  // 2) active → grace (paid tiers)
  const r1 = await pool.query(
    `UPDATE events.licenses SET status='grace', updated_at=NOW()
      WHERE status='active' AND tier=ANY($1::text[]) AND end_date < NOW()
      RETURNING id`, [PAID_TIERS]
  );
  summary.to_grace = r1.rowCount;

  // 3) grace → readonly
  const r2 = await pool.query(
    `UPDATE events.licenses SET status='readonly', updated_at=NOW()
      WHERE status='grace' AND end_date < NOW() - INTERVAL '15 days'
      RETURNING id`
  );
  summary.to_readonly = r2.rowCount;

  // 4) readonly → archive
  const r3 = await pool.query(
    `UPDATE events.licenses SET status='archive', updated_at=NOW()
      WHERE status='readonly' AND end_date < NOW() - INTERVAL '30 days'
      RETURNING id`
  );
  summary.to_archive = r3.rowCount;

  // 5) archive → wipe (end_date + 60d)
  const archWipe = await pool.query(
    `SELECT user_id FROM events.licenses
      WHERE status='archive' AND end_date < NOW() - INTERVAL '60 days'`
  );
  for (const row of archWipe.rows) {
    try {
      await withTransaction(pool, (c) => wipeTenant(c, row.user_id));
      summary.archive_wipe++;
      console.log(`✅ cron.events_license.archive_wipe user=${row.user_id}`);
    } catch (e) {
      console.error(`❌ cron.events_license.archive_wipe user=${row.user_id}:`, e.message);
    }
  }

  const anyMoved = Object.values(summary).some(v => v > 0);
  if (anyMoved) console.log('✅ cron.events_license.transitions', summary);
  return summary;
}

async function tick(pool) {
  try { await resetMonthlyCounters(pool); } catch (e) { console.error('❌ cron.events_license.counters:', e.message); }
  try { await transitionLicenseStates(pool); } catch (e) { console.error('❌ cron.events_license.transitions:', e.message); }
}

function start(pool, { intervalMs = 60 * 60 * 1000, initialDelayMs = 30 * 1000 } = {}) {
  setTimeout(() => tick(pool), initialDelayMs);
  return setInterval(() => tick(pool), intervalMs);
}

module.exports = { start, tick, resetMonthlyCounters, transitionLicenseStates, wipeTenant };
