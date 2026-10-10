// tools/test-events-emails.js — Smoke S208i
// Envía los 8 emails Events a sonoroaxm@gmail.com con datos mock.
// Uso en VPS: node tools/test-events-emails.js
require('dotenv').config({ path: '/opt/sonoro-cms/backend/.env' });

const E = require('/opt/sonoro-cms/backend/src/services/email.js');

const TO = 'sonoroaxm@gmail.com';

const attendee = {
  name: 'Daniel (smoke S208i)',
  email: TO,
  phone: '+57 300 000 0000',
};

const event = {
  id: 999,
  name: 'Evento Smoke S208i',
  slug: 'smoke-s208i',
  starts_at: '2026-11-15T19:00:00-05:00',
  ends_at: '2026-11-15T23:00:00-05:00',
  timezone: 'America/Bogota',
  venue_name: 'Teatro SONORO',
  venue_address: 'Calle 1 #2-3, Bogotá',
  dress_code: 'Formal',
};

const registration = {
  id: 1234,
  qr_token: '00000000-0000-0000-0000-000000000000',
  attendee_name: attendee.name,
  attendee_email: TO,
};

const batch = {
  id: 55,
  mode: 'claim',
  name: 'Lote Smoke',
  claim_token: 'claim-smoke-s208i',
};

const supplier = {
  supplier_name: 'Proveedor Smoke',
  contact_email: TO,
  event_name: event.name,
  starts_at: event.starts_at,
  timezone: event.timezone,
  service_description: 'Servicio de prueba para smoke S208i',
  contracted_amount: 1500000,
  deposit_amount: 500000,
  payment_proof_url: 'https://cms.sonoro.com.co/uploads/mock.pdf',
};

const quoteUrl = 'https://cms.sonoro.com.co/cotizacion/mock-token-smoke';

const tests = [
  ['sendEventPendingEmail',       () => E.sendEventPendingEmail(attendee, event)],
  ['sendEventRegistrationEmail',  () => E.sendEventRegistrationEmail(attendee, event, registration)],
  ['sendSupplierQuoteEmail',      () => E.sendSupplierQuoteEmail(supplier, quoteUrl)],
  ['sendSupplierAcceptedEmail',   () => E.sendSupplierAcceptedEmail(supplier)],
  ['sendSupplierDepositEmail',    () => E.sendSupplierDepositEmail(supplier)],
  ['sendSupplierPaidEmail',       () => E.sendSupplierPaidEmail(supplier)],
  ['sendInvitationConfirmedEmail',() => E.sendInvitationConfirmedEmail(attendee, event, registration, batch)],
  ['sendInvitationPendingEmail',  () => E.sendInvitationPendingEmail(attendee, event, batch)],
  ['sendStaffCredentialsEmail',   () => E.sendStaffCredentialsEmail(
    { id: 'uuid-x', name: 'María Pérez (smoke)', email: TO, role: 'registration', pin: '472918' },
    event,
    { name: 'Daniel Soriano', email: TO }
  )],
  ['sendStaffBriefingEmail',      () => E.sendStaffBriefingEmail(
    { id: 'uuid-x', name: 'María Pérez (smoke)', email: TO, role: 'registration', custom_briefing: 'María, por favor llega a las 5:45 PM para que te muestre la ubicación de las acreditaciones VIP. Guarda mi número para WhatsApp.' },
    event,
    { name: 'Daniel Soriano', email: TO }
  )],
];

(async () => {
  console.log(`\n=== Smoke S208i — enviando 8 emails Events a ${TO} ===\n`);
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  OK   ${name}`);
    } catch (err) {
      console.log(`  FAIL ${name}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log('\n=== Smoke terminado ===\n');
  process.exit(0);
})();
