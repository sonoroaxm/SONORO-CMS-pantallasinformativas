// Smoke test i18n-5: envía las 10 funciones de email Events en ES/EN/PT-BR
// Uso en VPS: cd /opt/sonoro-cms/backend && node ../tools/smoke-events-i18n.js
const path = require('path');
require('dotenv').config({ path: '/opt/sonoro-cms/backend/.env' });
const email = require('/opt/sonoro-cms/backend/src/services/email');

const TO = 'sonoroaxm@gmail.com';
const LOCALES = ['es', 'en', 'pt-BR'];

const event = {
  id: 999, slug: 'smoke-i18n', name: 'Smoke Test i18n Events',
  starts_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  ends_at:   new Date(Date.now() + 7 * 24 * 3600 * 1000 + 3 * 3600 * 1000).toISOString(),
  timezone: 'America/Bogota',
  venue_name: 'Centro de Convenciones Ágora',
  venue_address: 'Cra 40 #22C-67, Bogotá',
  config: { email_from_name: 'SONORO Events', email_reply_to: 'cms@sonoro.com.co' },
};
const emailCfg = { from_name: 'SONORO Events', reply_to: 'cms@sonoro.com.co' };
const producer = { name: 'Daniel Oviedo', email: 'cms@sonoro.com.co' };

async function run() {
  for (const loc of LOCALES) {
    console.log(`\n──── Locale: ${loc} ────`);
    const tag = `[${loc}]`;

    const attendee = { name: `Test ${tag}`, email: TO, locale: loc };
    const registration = { id: 1, qr_token: '00000000-0000-0000-0000-000000000001', ticket_type: 'general', status: 'confirmed' };
    const batch = { id: 1, claim_code: 'SMOKE123' };

    try { await email.sendEventPendingEmail(attendee, event, emailCfg); } catch(e) { console.error('pending:', e.message); }
    try { await email.sendEventRegistrationEmail(attendee, event, registration, emailCfg); } catch(e) { console.error('registration:', e.message); }
    try { await email.sendInvitationConfirmedEmail(attendee, event, registration, batch, emailCfg); } catch(e) { console.error('inv_confirmed:', e.message); }
    try { await email.sendInvitationPendingEmail(attendee, event, batch, emailCfg); } catch(e) { console.error('inv_pending:', e.message); }

    const supplier = {
      supplier_name: `Proveedor Test ${tag}`, contact_email: TO,
      event_name: event.name, contracted_amount: 2500000, deposit_amount: 1250000,
      payment_proof_url: 'https://cms.sonoro.com.co/',
      service_description: 'Catering coffee break ×50 pax',
      starts_at: event.starts_at, timezone: event.timezone,
      locale: loc,
    };
    try { await email.sendSupplierQuoteEmail(supplier, 'https://cms.sonoro.com.co/cotizacion/SMOKE', emailCfg); } catch(e) { console.error('sup_quote:', e.message); }
    try { await email.sendSupplierAcceptedEmail(supplier, emailCfg); } catch(e) { console.error('sup_accepted:', e.message); }
    try { await email.sendSupplierDepositEmail(supplier, emailCfg); } catch(e) { console.error('sup_deposit:', e.message); }
    try { await email.sendSupplierPaidEmail(supplier, emailCfg); } catch(e) { console.error('sup_paid:', e.message); }

    const staff = { id: 1, name: `Staff ${tag}`, email: TO, role: 'checkin', pin: '482910', custom_briefing: 'Llegar 15 min antes.', locale: loc };
    try { await email.sendStaffCredentialsEmail(staff, event, producer); } catch(e) { console.error('staff_creds:', e.message); }
    try { await email.sendStaffBriefingEmail(staff, event, producer); } catch(e) { console.error('staff_brief:', e.message); }
  }
  console.log('\n✅ Smoke completo — 30 emails enviados a', TO);
  process.exit(0);
}
run();
