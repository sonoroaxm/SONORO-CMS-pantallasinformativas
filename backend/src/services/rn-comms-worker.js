// E-RN-10 Block 7 — Rueda de Negocios Comms Worker
//
// 5 jobs idempotentes (UNIQUE indexes en events.rn_comms_log):
//   eod_digest     — diario @20:00 TZ-evento (si hubo reuniones ese día)
//   nudge_48h      — reunión terminada >48h sin outcome registrado (horario)
//   nudge_7d       — compromiso abierto sin movimiento 7d (diario @10:00 TZ)
//   due_pre_24h    — compromiso vence en 24-48h (diario @09:00 TZ)
//   due_overdue_24h — compromiso venció hace 24-48h sin cerrarse (diario @09:00 TZ)
//
// Guardrails por envío:
//   1. event.config.rn_comms[<flag>] habilita (eod_digest ON por default; nudges OFF)
//   2. event.config.rn_comms.paused !== true (kill-switch productor)
//   3. rn_delegates.comms_opt_out !== true (Habeas Data Ley 1581)
//   4. INSERT ON CONFLICT DO NOTHING en rn_comms_log reclama slot (idempotencia)
//   5. event.status IN ('active','finished','ongoing') — no archived/cancelled
//   6. RN_COMMS_ENABLED env flag (kill-switch global)

'use strict';

const email = require('./email');

const TICK_MS = 5 * 60 * 1000;
const CMS_URL = process.env.CMS_URL || 'https://cms.sonoro.com.co';

function nowPartsIn(tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(new Date()).reduce((a,p) => { a[p.type] = p.value; return a; }, {});
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
  };
}

function agendaUrl(slug, token) {
  return `${CMS_URL}/evento/${slug}/mi-agenda?token=${token}`;
}

function panelUrl(eventId) {
  return `${CMS_URL}/dashboard.html#events/${eventId}/rueda/comms`;
}

function commsFlag(cfg, key, defaultOn = false) {
  const c = (cfg && cfg.rn_comms) || {};
  if (c.paused === true) return false;
  if (key === 'eod_digest') return c.eod_digest !== false;
  return c[key] === true || c[key] === 'true';
}

// ────────────────────────────────────────────────────────────────
// JOB 1 — EOD DIGEST
// ────────────────────────────────────────────────────────────────
async function runEodDigest(pool, event) {
  if (!commsFlag(event.config, 'eod_digest')) return 0;
  const { dayKey } = nowPartsIn(event.timezone || 'America/Bogota');

  const delQ = await pool.query(`
    SELECT DISTINCT d.id, d.registration_id, d.full_name, d.email, d.locale, d.agenda_token,
           r.company_name, r.custom_fields, a.organization, a.name AS attendee_name
      FROM events.rn_delegates d
      JOIN events.registrations r ON r.id = d.registration_id
      LEFT JOIN events.attendees a ON a.id = r.attendee_id
      JOIN events.rn_meetings m ON (m.company_a_id = r.id OR m.company_b_id = r.id)
     WHERE r.event_id = $1
       AND d.comms_opt_out = false
       AND d.email IS NOT NULL
       AND (m.started_at AT TIME ZONE $2)::date = $3::date
       AND m.ended_at IS NOT NULL
  `, [event.id, event.timezone || 'America/Bogota', dayKey]);

  let sent = 0;
  for (const d of delQ.rows) {
    const claim = await pool.query(`
      INSERT INTO events.rn_comms_log
        (event_id, user_id, delegate_id, nudge_type, digest_day, scheduled_for)
      VALUES ($1, $2, $3, 'eod_digest', $4::date, NOW())
      ON CONFLICT (delegate_id, digest_day) WHERE nudge_type = 'eod_digest'
      DO NOTHING
      RETURNING id
    `, [event.id, event.user_id, d.id, dayKey]);
    if (claim.rowCount === 0) continue;

    const m2 = await pool.query(`
      SELECT
        COUNT(*)::int AS reuniones,
        COUNT(o.id)::int AS outcomes,
        (COUNT(*) FILTER (WHERE o.id IS NULL))::int AS pendientes_outcome,
        (COUNT(o.id) FILTER (WHERE o.next_step <> 'none' AND o.completed_at IS NULL))::int AS compromisos_abiertos
        FROM events.rn_meetings m
        LEFT JOIN events.rn_meeting_outcomes o
          ON o.meeting_id = m.id AND o.delegate_id = $1
       WHERE (m.company_a_id = $2 OR m.company_b_id = $2)
         AND m.event_id = $3
         AND m.ended_at IS NOT NULL
         AND (m.started_at AT TIME ZONE $4)::date = $5::date
    `, [d.id, d.registration_id, event.id, event.timezone || 'America/Bogota', dayKey]);

    const met = m2.rows[0] || { reuniones: 0, outcomes: 0, pendientes_outcome: 0, compromisos_abiertos: 0 };
    if (met.reuniones === 0) {
      await pool.query(
        `UPDATE events.rn_comms_log SET skipped_reason='no_meetings_today' WHERE id=$1`,
        [claim.rows[0].id]
      );
      continue;
    }

    try {
      const companyName = (d.custom_fields && d.custom_fields.company_name)
        || d.organization || d.company_name || d.attendee_name || '';
      await email.sendRnEodDigestEmail({
        to: d.email,
        delegateName: d.full_name,
        companyName,
        eventName: event.name,
        dayLabel: dayKey,
        metrics: met,
        agendaUrl: agendaUrl(event.slug, d.agenda_token),
        locale: d.locale || 'es',
      });
      await pool.query(
        `UPDATE events.rn_comms_log SET sent_at=NOW() WHERE id=$1`,
        [claim.rows[0].id]
      );
      sent++;
    } catch (err) {
      console.error(`[rn-comms] eod_digest send error delegate=${d.id}:`, err.message);
      await pool.query(
        `UPDATE events.rn_comms_log SET skipped_reason=$2 WHERE id=$1`,
        [claim.rows[0].id, `send_error:${err.code || 'unknown'}`.slice(0, 60)]
      );
    }
  }
  return sent;
}

// ────────────────────────────────────────────────────────────────
// JOB 2 — NUDGE 48h (reunión sin outcome)
// ────────────────────────────────────────────────────────────────
async function runNudge48h(pool, event) {
  if (!commsFlag(event.config, 'nudge_48h')) return 0;

  const cand = await pool.query(`
    SELECT m.id AS meeting_id,
           d.id AS delegate_id, d.full_name, d.email, d.locale, d.agenda_token,
           r.company_name AS self_company,
           rc.company_name AS counter_company,
           ac.name AS counter_attendee,
           CASE WHEN m.company_a_id = r.id THEN 'A' ELSE 'B' END AS side
      FROM events.rn_meetings m
      JOIN events.registrations r ON r.id IN (m.company_a_id, m.company_b_id)
      JOIN events.rn_delegates d ON d.registration_id = r.id
      JOIN events.registrations rc
        ON rc.id = CASE WHEN m.company_a_id = r.id THEN m.company_b_id ELSE m.company_a_id END
      LEFT JOIN events.attendees ac ON ac.id = rc.attendee_id
     WHERE m.event_id = $1
       AND m.ended_at IS NOT NULL
       AND m.ended_at < NOW() - INTERVAL '48 hours'
       AND m.ended_at > NOW() - INTERVAL '14 days'
       AND d.comms_opt_out = false
       AND d.email IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM events.rn_meeting_outcomes o
          WHERE o.meeting_id = m.id AND o.delegate_id = d.id
       )
  `, [event.id]);

  let sent = 0;
  for (const row of cand.rows) {
    const claim = await pool.query(`
      INSERT INTO events.rn_comms_log
        (event_id, user_id, delegate_id, meeting_id, nudge_type, scheduled_for)
      VALUES ($1, $2, $3, $4, 'nudge_48h', NOW())
      ON CONFLICT (meeting_id, delegate_id, nudge_type)
        WHERE nudge_type IN ('nudge_48h','nudge_7d')
      DO NOTHING
      RETURNING id
    `, [event.id, event.user_id, row.delegate_id, row.meeting_id]);
    if (claim.rowCount === 0) continue;

    try {
      await email.sendRnNudge48hEmail({
        to: row.email,
        delegateName: row.full_name,
        counterpartName: row.counter_company || row.counter_attendee || '—',
        eventName: event.name,
        agendaUrl: agendaUrl(event.slug, row.agenda_token),
        locale: row.locale || 'es',
      });
      await pool.query(`UPDATE events.rn_comms_log SET sent_at=NOW() WHERE id=$1`, [claim.rows[0].id]);
      sent++;
    } catch (err) {
      console.error(`[rn-comms] nudge_48h error:`, err.message);
      await pool.query(
        `UPDATE events.rn_comms_log SET skipped_reason=$2 WHERE id=$1`,
        [claim.rows[0].id, `send_error:${(err.code||'unk')}`.slice(0,60)]
      );
    }
  }
  return sent;
}

// ────────────────────────────────────────────────────────────────
// JOB 3 — NUDGE 7d (compromiso abierto sin movimiento)
// ────────────────────────────────────────────────────────────────
async function runNudge7d(pool, event) {
  if (!commsFlag(event.config, 'nudge_7d')) return 0;

  const cand = await pool.query(`
    SELECT o.id AS outcome_id, o.meeting_id,
           d.id AS delegate_id, d.full_name, d.email, d.locale, d.agenda_token,
           rc.company_name AS counter_company,
           ac.name AS counter_attendee,
           o.next_step
      FROM events.rn_meeting_outcomes o
      JOIN events.rn_delegates d ON d.id = o.delegate_id
      JOIN events.rn_meetings m ON m.id = o.meeting_id
      JOIN events.registrations rc
        ON rc.id = CASE WHEN o.side = 'A' THEN m.company_b_id ELSE m.company_a_id END
      LEFT JOIN events.attendees ac ON ac.id = rc.attendee_id
     WHERE m.event_id = $1
       AND o.next_step <> 'none'
       AND o.completed_at IS NULL
       AND o.updated_at < NOW() - INTERVAL '7 days'
       AND o.updated_at > NOW() - INTERVAL '60 days'
       AND d.comms_opt_out = false
       AND d.email IS NOT NULL
  `, [event.id]);

  let sent = 0;
  for (const row of cand.rows) {
    const claim = await pool.query(`
      INSERT INTO events.rn_comms_log
        (event_id, user_id, delegate_id, meeting_id, outcome_id, nudge_type, scheduled_for)
      VALUES ($1, $2, $3, $4, $5, 'nudge_7d', NOW())
      ON CONFLICT (meeting_id, delegate_id, nudge_type)
        WHERE nudge_type IN ('nudge_48h','nudge_7d')
      DO NOTHING
      RETURNING id
    `, [event.id, event.user_id, row.delegate_id, row.meeting_id, row.outcome_id]);
    if (claim.rowCount === 0) continue;

    try {
      await email.sendRnNudge7dEmail({
        to: row.email,
        delegateName: row.full_name,
        counterpartName: row.counter_company || row.counter_attendee || '—',
        nextStep: row.next_step,
        eventName: event.name,
        agendaUrl: agendaUrl(event.slug, row.agenda_token),
        locale: row.locale || 'es',
      });
      await pool.query(`UPDATE events.rn_comms_log SET sent_at=NOW() WHERE id=$1`, [claim.rows[0].id]);
      sent++;
    } catch (err) {
      console.error(`[rn-comms] nudge_7d error:`, err.message);
      await pool.query(
        `UPDATE events.rn_comms_log SET skipped_reason=$2 WHERE id=$1`,
        [claim.rows[0].id, `send_error:${(err.code||'unk')}`.slice(0,60)]
      );
    }
  }
  return sent;
}

// ────────────────────────────────────────────────────────────────
// JOB 4 — DUE PRE 24H
// ────────────────────────────────────────────────────────────────
async function runDuePre24h(pool, event) {
  if (!commsFlag(event.config, 'due_pre_24h')) return 0;
  return _runDueNudge(pool, event, 'due_pre_24h',
    `AND o.due_at BETWEEN NOW() + INTERVAL '24 hours' AND NOW() + INTERVAL '48 hours'`,
    email.sendRnDuePre24hEmail);
}

// ────────────────────────────────────────────────────────────────
// JOB 5 — DUE OVERDUE 24H
// ────────────────────────────────────────────────────────────────
async function runDueOverdue24h(pool, event) {
  if (!commsFlag(event.config, 'due_overdue_24h')) return 0;
  return _runDueNudge(pool, event, 'due_overdue_24h',
    `AND o.due_at BETWEEN NOW() - INTERVAL '48 hours' AND NOW() - INTERVAL '24 hours'`,
    email.sendRnDueOverdue24hEmail);
}

async function _runDueNudge(pool, event, nudgeType, dueClause, mailer) {
  const cand = await pool.query(`
    SELECT o.id AS outcome_id, o.meeting_id, o.due_at, o.next_step,
           d.id AS delegate_id, d.full_name, d.email, d.locale, d.agenda_token,
           rc.company_name AS counter_company,
           ac.name AS counter_attendee
      FROM events.rn_meeting_outcomes o
      JOIN events.rn_delegates d ON d.id = o.delegate_id
      JOIN events.rn_meetings m ON m.id = o.meeting_id
      JOIN events.registrations rc
        ON rc.id = CASE WHEN o.side = 'A' THEN m.company_b_id ELSE m.company_a_id END
      LEFT JOIN events.attendees ac ON ac.id = rc.attendee_id
     WHERE m.event_id = $1
       AND o.completed_at IS NULL
       AND (o.owner_side = o.side OR o.owner_side = 'both')
       AND d.comms_opt_out = false
       AND d.email IS NOT NULL
       ${dueClause}
  `, [event.id]);

  let sent = 0;
  for (const row of cand.rows) {
    const claim = await pool.query(`
      INSERT INTO events.rn_comms_log
        (event_id, user_id, delegate_id, meeting_id, outcome_id, nudge_type, scheduled_for)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (outcome_id, nudge_type)
        WHERE nudge_type IN ('due_pre_24h','due_overdue_24h')
      DO NOTHING
      RETURNING id
    `, [event.id, event.user_id, row.delegate_id, row.meeting_id, row.outcome_id, nudgeType]);
    if (claim.rowCount === 0) continue;

    try {
      await mailer({
        to: row.email,
        delegateName: row.full_name,
        counterpartName: row.counter_company || row.counter_attendee || '—',
        nextStep: row.next_step,
        dueAt: row.due_at,
        eventName: event.name,
        agendaUrl: agendaUrl(event.slug, row.agenda_token),
        locale: row.locale || 'es',
      });
      await pool.query(`UPDATE events.rn_comms_log SET sent_at=NOW() WHERE id=$1`, [claim.rows[0].id]);
      sent++;
    } catch (err) {
      console.error(`[rn-comms] ${nudgeType} error:`, err.message);
      await pool.query(
        `UPDATE events.rn_comms_log SET skipped_reason=$2 WHERE id=$1`,
        [claim.rows[0].id, `send_error:${(err.code||'unk')}`.slice(0,60)]
      );
    }
  }
  return sent;
}

// ────────────────────────────────────────────────────────────────
// TICK ORCHESTRATOR
// ────────────────────────────────────────────────────────────────
function start(pool) {
  if (process.env.RN_COMMS_ENABLED === 'false') {
    console.log('[rn-comms] DESHABILITADO (RN_COMMS_ENABLED=false)');
    return null;
  }

  const state = {}; // { 'eod:<eventId>:<dayKey>': true, 'nudge7d:<eventId>:<dayKey>': ... }

  async function tick() {
    try {
      const evQ = await pool.query(`
        SELECT id, user_id, slug, name, timezone, config, status
          FROM events.events
         WHERE status IN ('active','published','ongoing','finished')
           AND (config->>'rn_enabled')::boolean = true
      `);
      for (const ev of evQ.rows) {
        const tz = ev.timezone || 'America/Bogota';
        const { dayKey, hour } = nowPartsIn(tz);

        // Hourly: nudge_48h (reunión-driven, no limitado a hora específica)
        try { await runNudge48h(pool, ev); } catch (e) { console.error('[rn-comms] nudge48h:', e.message); }

        // Daily @ 09:00 TZ: due_pre_24h + due_overdue_24h
        if (hour === 9) {
          const k = `due:${ev.id}:${dayKey}`;
          if (!state[k]) {
            state[k] = true;
            try { await runDuePre24h(pool, ev); } catch (e) { console.error('[rn-comms] duePre:', e.message); }
            try { await runDueOverdue24h(pool, ev); } catch (e) { console.error('[rn-comms] dueOver:', e.message); }
          }
        }

        // Daily @ 10:00 TZ: nudge_7d
        if (hour === 10) {
          const k = `n7d:${ev.id}:${dayKey}`;
          if (!state[k]) {
            state[k] = true;
            try { await runNudge7d(pool, ev); } catch (e) { console.error('[rn-comms] nudge7d:', e.message); }
          }
        }

        // Daily @ 20:00 TZ: eod_digest
        if (hour === 20) {
          const k = `eod:${ev.id}:${dayKey}`;
          if (!state[k]) {
            state[k] = true;
            try { await runEodDigest(pool, ev); } catch (e) { console.error('[rn-comms] eod:', e.message); }
          }
        }
      }
      // Housekeeping: limpiar state con dayKey viejas (>3 días)
      const cutoff = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
      for (const k of Object.keys(state)) {
        const parts = k.split(':');
        const d = parts[parts.length - 1];
        if (d < cutoff) delete state[k];
      }
    } catch (err) {
      console.error('[rn-comms] tick error:', err.message);
    }
  }

  const handle = setInterval(tick, TICK_MS);
  setTimeout(tick, 30 * 1000); // kick-off 30s después del boot
  console.log('[rn-comms] worker iniciado (tick 5min)');
  return handle;
}

module.exports = {
  start,
  runEodDigest,
  runNudge48h,
  runNudge7d,
  runDuePre24h,
  runDueOverdue24h,
};
