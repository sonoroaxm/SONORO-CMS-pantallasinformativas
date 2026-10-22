/**
 * ============================================================
 * SONORO AV — Servicio de Email
 * backend/src/services/email.js
 * ============================================================
 */

const nodemailer = require('nodemailer');
const path = require('path');
const fs   = require('fs');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'mail.sonoro.com.co',
  port:   parseInt(process.env.SMTP_PORT) || 465,
  secure: true, // true para puerto 465
  auth: {
    user: process.env.SMTP_USER || 'cms@sonoro.com.co',
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: true
  }
});

const CMS_URL  = process.env.CMS_URL  || 'https://cms.sonoro.com.co';
const FROM     = process.env.SMTP_FROM || 'SONORO CMS <cms@sonoro.com.co>';

// ─────────────────────────────────────────────────────────────
// Events v1 · i18n por destinatario
// Opción B: cada attendee/staff/supplier guarda su locale (col BD).
// Fallback 'es'. Valores soportados: 'es' | 'en' | 'pt-BR'.
// Helper: EVTT(locale, 'namespace.key', { var: 'x' })
// ─────────────────────────────────────────────────────────────
const EVENTS_LOCALES = ['es', 'en', 'pt-BR'];
function normalizeLocale(loc) {
  if (!loc) return 'es';
  if (EVENTS_LOCALES.includes(loc)) return loc;
  const base = String(loc).toLowerCase().split('-')[0];
  if (base === 'en') return 'en';
  if (base === 'pt') return 'pt-BR';
  return 'es';
}
function localeDateFmt(loc) {
  if (loc === 'en') return 'en-US';
  if (loc === 'pt-BR') return 'pt-BR';
  return 'es-CO';
}
const EVENTS_I18N = {
  'es': {
    tagline: 'Software de gestión de eventos',
    pending: {
      subject: 'Inscripción recibida — {event}',
      h1: 'Inscripción recibida',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, tu inscripción a <strong style="color:#0f0f0f;">{event}</strong> ha sido recibida y está <strong style="color:#f59e0b;">pendiente de confirmación</strong> por el organizador.',
      note: 'Pronto recibirás un correo con tu pase de acceso (código QR) una vez que tu inscripción sea confirmada.',
      lbl_event: 'Evento', lbl_date: 'Fecha', lbl_venue: 'Lugar',
      disclaimer: 'Si no te registraste en este evento, ignora este mensaje.',
      tagline: 'Software de gestión de eventos'
    },
    registration: {
      subject: 'Tu pase para {event}',
      h1: 'Tu registro está confirmado',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, aquí está tu pase para el evento.',
      lbl_event: 'Evento', lbl_start: 'Inicio', lbl_end: 'Cierre', lbl_venue: 'Lugar', lbl_ticket: 'Tipo de entrada',
      qr_prompt: 'Presenta este código QR al ingresar al evento',
      cta: 'Ver mi registro',
      disclaimer: 'Si no te registraste en este evento, ignora este mensaje.',
      qr_alt: 'Código QR'
    },
    supplier_quote: {
      subject: 'Solicitud de cotización — {event}',
      h1: 'Solicitud de cotización',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>,<br>Te invitamos a cotizar tus servicios para el siguiente evento:',
      lbl_event: 'Evento', lbl_date: 'Fecha', lbl_service: 'Servicio solicitado',
      body: 'Usa el formulario en línea para enviar tu cotización. Puedes incluir precios, condiciones y adjuntar tu propuesta en PDF.',
      cta: 'Enviar mi cotización',
      single_use: 'Este enlace es de uso único para {name}. No reenvíes este correo.'
    },
    supplier_accepted: {
      subject: 'Cotización aceptada — {event}',
      h1: 'Tu cotización ha sido aceptada',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>,<br>Nos complace informarte que tu cotización para el siguiente evento ha sido <strong style="color:#22c55e;">aceptada</strong>.',
      lbl_event: 'Evento', lbl_amount: 'Monto acordado',
      closing: 'El equipo de producción se comunicará contigo para coordinar los próximos pasos. Gracias por tu propuesta.'
    },
    supplier_deposit: {
      subject: 'Abono registrado — {event}',
      h1: 'Abono registrado',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>,<br>Hemos registrado un abono para tu contrato en el siguiente evento:',
      lbl_event: 'Evento', lbl_received: 'Abono recibido', lbl_pending: 'Saldo pendiente',
      proof_note: 'Se adjunta el comprobante de pago para tu registro.',
      closing: 'Ante cualquier consulta, responde este correo y nuestro equipo te atenderá.'
    },
    supplier_paid: {
      subject: 'Pago completado — {event}',
      h1: 'Pago completo registrado',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>,<br>Nos complace informarte que hemos registrado el <strong style="color:#10b981;">pago completo</strong> de tu contrato.',
      lbl_event: 'Evento', lbl_total: 'Total pagado',
      proof_note: 'Se adjunta el comprobante del pago final para tu archivo.',
      closing: 'Gracias por tu trabajo. Esperamos contar contigo en futuros eventos.'
    },
    invitation_confirmed: {
      subject: 'Acreditación confirmada — {event}',
      badge_suffix: 'Invitación',
      h1: 'Tu acreditación está lista',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, gracias por confirmar tu participación en <strong style="color:#0f0f0f;">{event}</strong>.',
      lbl_event: 'Evento', lbl_start: 'Inicio', lbl_end: 'Cierre', lbl_venue: 'Lugar', lbl_credential: 'Acreditación',
      notes_header: 'Notas del organizador',
      qr_prompt: 'Presenta este código QR al ingresar',
      cta: 'Ver mi acreditación',
      disclaimer: 'Si no esperabas esta invitación, ignora este mensaje.'
    },
    invitation_pending: {
      subject: 'Acreditación pendiente — {event}',
      badge_suffix: 'Invitación',
      h1: 'Recibimos tu confirmación',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, tu participación en <strong style="color:#0f0f0f;">{event}</strong> está <strong style="color:#f59e0b;">pendiente de aprobación</strong> por el organizador.',
      note: 'Te enviaremos tu acreditación con código QR en cuanto el organizador confirme tu participación.',
      lbl_event: 'Evento', lbl_date: 'Fecha', lbl_credential: 'Acreditación',
      notes_header: 'Notas del organizador',
      disclaimer: 'Si no esperabas esta invitación, ignora este mensaje.'
    },
    staff_credentials: {
      subject: 'Credenciales de acceso · {event}',
      h1: 'Bienvenido al equipo',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, <strong style="color:#0f0f0f;">{producer}</strong> te acaba de registrar como parte del equipo del evento <strong style="color:#0f0f0f;">{event}</strong>. Rol asignado: <strong style="color:#0f0f0f;">{role}</strong>.',
      pin_label: 'Tu PIN de acceso',
      pin_help: 'Guárdalo seguro — lo necesitarás para iniciar sesión en el panel del evento. Si necesitas renovarlo, pídele al productor que lo regenere.',
      cta: 'Abrir panel del evento',
      lbl_event: 'Evento', lbl_date: 'Fecha', lbl_venue: 'Lugar', lbl_producer: 'Productor responsable',
      briefing_note: 'Pronto recibirás un segundo correo con el briefing detallado de tus responsabilidades para el día del evento.',
      producer_fallback: 'el productor'
    },
    staff_briefing: {
      subject: 'Briefing · {event}',
      h1: 'Tu briefing para el evento',
      intro: 'Hola <strong style="color:#0f0f0f;">{name}</strong>, aquí están tus responsabilidades para <strong style="color:#0f0f0f;">{event}</strong>. Léelo con calma antes del día del evento.',
      lbl_role: 'Rol', lbl_datetime: 'Fecha y hora', lbl_arrival: 'Llegada sugerida', lbl_venue: 'Lugar',
      arrival_prefix: '1 hora antes',
      resp_header: 'Responsabilidades del rol',
      custom_header: 'Mensaje del productor',
      cta: 'Abrir panel del evento',
      help_note: 'Si tienes alguna duda sobre tus responsabilidades, contacta al productor <strong>{producer}</strong> en <a href="mailto:{email}" style="color:#1e3a8a;">{email}</a>.',
      producer_fallback: 'el productor'
    }
  },
  'en': {
    tagline: 'Event management software',
    pending: {
      subject: 'Registration received — {event}',
      h1: 'Registration received',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, your registration for <strong style="color:#0f0f0f;">{event}</strong> has been received and is <strong style="color:#f59e0b;">pending confirmation</strong> by the organizer.',
      note: 'You will receive an email with your access pass (QR code) once your registration is confirmed.',
      lbl_event: 'Event', lbl_date: 'Date', lbl_venue: 'Venue',
      disclaimer: 'If you did not register for this event, please ignore this message.',
      tagline: 'Event management software'
    },
    registration: {
      subject: 'Your pass for {event}',
      h1: 'Your registration is confirmed',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, here is your pass for the event.',
      lbl_event: 'Event', lbl_start: 'Start', lbl_end: 'End', lbl_venue: 'Venue', lbl_ticket: 'Ticket type',
      qr_prompt: 'Show this QR code at the entrance',
      cta: 'View my registration',
      disclaimer: 'If you did not register for this event, please ignore this message.',
      qr_alt: 'QR code'
    },
    supplier_quote: {
      subject: 'Quote request — {event}',
      h1: 'Quote request',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>,<br>We invite you to submit a quote for your services for the following event:',
      lbl_event: 'Event', lbl_date: 'Date', lbl_service: 'Requested service',
      body: 'Use the online form to submit your quote. You can include pricing, terms and attach your proposal as a PDF.',
      cta: 'Submit my quote',
      single_use: 'This link is single-use for {name}. Please do not forward this email.'
    },
    supplier_accepted: {
      subject: 'Quote accepted — {event}',
      h1: 'Your quote has been accepted',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>,<br>We are pleased to inform you that your quote for the following event has been <strong style="color:#22c55e;">accepted</strong>.',
      lbl_event: 'Event', lbl_amount: 'Agreed amount',
      closing: 'The production team will reach out to coordinate the next steps. Thank you for your proposal.'
    },
    supplier_deposit: {
      subject: 'Deposit recorded — {event}',
      h1: 'Deposit recorded',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>,<br>We have recorded a deposit for your contract on the following event:',
      lbl_event: 'Event', lbl_received: 'Deposit received', lbl_pending: 'Outstanding balance',
      proof_note: 'The payment receipt is attached for your records.',
      closing: 'For any questions, reply to this email and our team will assist you.'
    },
    supplier_paid: {
      subject: 'Payment completed — {event}',
      h1: 'Full payment recorded',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>,<br>We are pleased to inform you that we have recorded the <strong style="color:#10b981;">full payment</strong> of your contract.',
      lbl_event: 'Event', lbl_total: 'Total paid',
      proof_note: 'The final payment receipt is attached for your records.',
      closing: 'Thank you for your work. We look forward to working with you on future events.'
    },
    invitation_confirmed: {
      subject: 'Accreditation confirmed — {event}',
      badge_suffix: 'Invitation',
      h1: 'Your accreditation is ready',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, thank you for confirming your participation in <strong style="color:#0f0f0f;">{event}</strong>.',
      lbl_event: 'Event', lbl_start: 'Start', lbl_end: 'End', lbl_venue: 'Venue', lbl_credential: 'Accreditation',
      notes_header: 'Organizer notes',
      qr_prompt: 'Show this QR code at the entrance',
      cta: 'View my accreditation',
      disclaimer: 'If you were not expecting this invitation, please ignore this message.'
    },
    invitation_pending: {
      subject: 'Accreditation pending — {event}',
      badge_suffix: 'Invitation',
      h1: 'We received your confirmation',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, your participation in <strong style="color:#0f0f0f;">{event}</strong> is <strong style="color:#f59e0b;">pending approval</strong> by the organizer.',
      note: 'We will send your accreditation with QR code as soon as the organizer confirms your participation.',
      lbl_event: 'Event', lbl_date: 'Date', lbl_credential: 'Accreditation',
      notes_header: 'Organizer notes',
      disclaimer: 'If you were not expecting this invitation, please ignore this message.'
    },
    staff_credentials: {
      subject: 'Access credentials · {event}',
      h1: 'Welcome to the team',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, <strong style="color:#0f0f0f;">{producer}</strong> has just added you to the team for <strong style="color:#0f0f0f;">{event}</strong>. Assigned role: <strong style="color:#0f0f0f;">{role}</strong>.',
      pin_label: 'Your access PIN',
      pin_help: 'Keep it safe, you will need it to sign in to the event panel. If you need to renew it, ask the producer to regenerate it.',
      cta: 'Open event panel',
      lbl_event: 'Event', lbl_date: 'Date', lbl_venue: 'Venue', lbl_producer: 'Producer in charge',
      briefing_note: 'You will soon receive a second email with the detailed briefing of your responsibilities for the day of the event.',
      producer_fallback: 'the producer'
    },
    staff_briefing: {
      subject: 'Briefing · {event}',
      h1: 'Your briefing for the event',
      intro: 'Hi <strong style="color:#0f0f0f;">{name}</strong>, here are your responsibilities for <strong style="color:#0f0f0f;">{event}</strong>. Please read it carefully before the day of the event.',
      lbl_role: 'Role', lbl_datetime: 'Date and time', lbl_arrival: 'Suggested arrival', lbl_venue: 'Venue',
      arrival_prefix: '1 hour before',
      resp_header: 'Role responsibilities',
      custom_header: 'Message from the producer',
      cta: 'Open event panel',
      help_note: 'If you have any questions about your responsibilities, contact the producer <strong>{producer}</strong> at <a href="mailto:{email}" style="color:#1e3a8a;">{email}</a>.',
      producer_fallback: 'the producer'
    }
  },
  'pt-BR': {
    tagline: 'Software de gestão de eventos',
    pending: {
      subject: 'Inscrição recebida — {event}',
      h1: 'Inscrição recebida',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, sua inscrição em <strong style="color:#0f0f0f;">{event}</strong> foi recebida e está <strong style="color:#f59e0b;">pendente de confirmação</strong> pelo organizador.',
      note: 'Em breve você receberá um e-mail com seu passe de acesso (código QR) assim que sua inscrição for confirmada.',
      lbl_event: 'Evento', lbl_date: 'Data', lbl_venue: 'Local',
      disclaimer: 'Se você não se inscreveu neste evento, ignore esta mensagem.',
      tagline: 'Software de gestão de eventos'
    },
    registration: {
      subject: 'Seu passe para {event}',
      h1: 'Seu registro está confirmado',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, aqui está seu passe para o evento.',
      lbl_event: 'Evento', lbl_start: 'Início', lbl_end: 'Encerramento', lbl_venue: 'Local', lbl_ticket: 'Tipo de ingresso',
      qr_prompt: 'Apresente este código QR na entrada do evento',
      cta: 'Ver meu registro',
      disclaimer: 'Se você não se inscreveu neste evento, ignore esta mensagem.',
      qr_alt: 'Código QR'
    },
    supplier_quote: {
      subject: 'Solicitação de cotação — {event}',
      h1: 'Solicitação de cotação',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>,<br>Convidamos você a cotar seus serviços para o seguinte evento:',
      lbl_event: 'Evento', lbl_date: 'Data', lbl_service: 'Serviço solicitado',
      body: 'Use o formulário online para enviar sua cotação. Você pode incluir preços, condições e anexar sua proposta em PDF.',
      cta: 'Enviar minha cotação',
      single_use: 'Este link é de uso único para {name}. Não encaminhe este e-mail.'
    },
    supplier_accepted: {
      subject: 'Cotação aceita — {event}',
      h1: 'Sua cotação foi aceita',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>,<br>Temos o prazer de informar que sua cotação para o seguinte evento foi <strong style="color:#22c55e;">aceita</strong>.',
      lbl_event: 'Evento', lbl_amount: 'Valor acordado',
      closing: 'A equipe de produção entrará em contato para coordenar os próximos passos. Obrigado pela sua proposta.'
    },
    supplier_deposit: {
      subject: 'Entrada registrada — {event}',
      h1: 'Entrada registrada',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>,<br>Registramos uma entrada para o seu contrato no seguinte evento:',
      lbl_event: 'Evento', lbl_received: 'Entrada recebida', lbl_pending: 'Saldo pendente',
      proof_note: 'O comprovante de pagamento está anexado para seu registro.',
      closing: 'Em caso de dúvidas, responda a este e-mail e nossa equipe irá atendê-lo.'
    },
    supplier_paid: {
      subject: 'Pagamento concluído — {event}',
      h1: 'Pagamento total registrado',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>,<br>Temos o prazer de informar que registramos o <strong style="color:#10b981;">pagamento total</strong> do seu contrato.',
      lbl_event: 'Evento', lbl_total: 'Total pago',
      proof_note: 'O comprovante do pagamento final está anexado para seu arquivo.',
      closing: 'Obrigado pelo seu trabalho. Esperamos contar com você em eventos futuros.'
    },
    invitation_confirmed: {
      subject: 'Credenciamento confirmado — {event}',
      badge_suffix: 'Convite',
      h1: 'Seu credenciamento está pronto',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, obrigado por confirmar sua participação em <strong style="color:#0f0f0f;">{event}</strong>.',
      lbl_event: 'Evento', lbl_start: 'Início', lbl_end: 'Encerramento', lbl_venue: 'Local', lbl_credential: 'Credenciamento',
      notes_header: 'Notas do organizador',
      qr_prompt: 'Apresente este código QR na entrada',
      cta: 'Ver meu credenciamento',
      disclaimer: 'Se você não esperava este convite, ignore esta mensagem.'
    },
    invitation_pending: {
      subject: 'Credenciamento pendente — {event}',
      badge_suffix: 'Convite',
      h1: 'Recebemos sua confirmação',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, sua participação em <strong style="color:#0f0f0f;">{event}</strong> está <strong style="color:#f59e0b;">pendente de aprovação</strong> pelo organizador.',
      note: 'Enviaremos seu credenciamento com código QR assim que o organizador confirmar sua participação.',
      lbl_event: 'Evento', lbl_date: 'Data', lbl_credential: 'Credenciamento',
      notes_header: 'Notas do organizador',
      disclaimer: 'Se você não esperava este convite, ignore esta mensagem.'
    },
    staff_credentials: {
      subject: 'Credenciais de acesso · {event}',
      h1: 'Bem-vindo(a) à equipe',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, <strong style="color:#0f0f0f;">{producer}</strong> acabou de registrar você como parte da equipe do evento <strong style="color:#0f0f0f;">{event}</strong>. Função atribuída: <strong style="color:#0f0f0f;">{role}</strong>.',
      pin_label: 'Seu PIN de acesso',
      pin_help: 'Guarde-o em local seguro — você precisará dele para entrar no painel do evento. Se precisar renová-lo, peça ao produtor para gerar um novo.',
      cta: 'Abrir painel do evento',
      lbl_event: 'Evento', lbl_date: 'Data', lbl_venue: 'Local', lbl_producer: 'Produtor responsável',
      briefing_note: 'Em breve você receberá um segundo e-mail com o briefing detalhado das suas responsabilidades para o dia do evento.',
      producer_fallback: 'o produtor'
    },
    staff_briefing: {
      subject: 'Briefing · {event}',
      h1: 'Seu briefing para o evento',
      intro: 'Olá <strong style="color:#0f0f0f;">{name}</strong>, aqui estão suas responsabilidades para <strong style="color:#0f0f0f;">{event}</strong>. Leia com calma antes do dia do evento.',
      lbl_role: 'Função', lbl_datetime: 'Data e hora', lbl_arrival: 'Chegada sugerida', lbl_venue: 'Local',
      arrival_prefix: '1 hora antes',
      resp_header: 'Responsabilidades da função',
      custom_header: 'Mensagem do produtor',
      cta: 'Abrir painel do evento',
      help_note: 'Se tiver dúvidas sobre suas responsabilidades, entre em contato com o produtor <strong>{producer}</strong> em <a href="mailto:{email}" style="color:#1e3a8a;">{email}</a>.',
      producer_fallback: 'o produtor'
    }
  }
};

// ── Role templates i18n (reemplaza STAFF_ROLE_TEMPLATES para emails Events) ──
const STAFF_ROLE_TEMPLATES_I18N = {
  'es': {
    coordinator: { label: 'Coordinador general', bullets: [
      'Supervisar al equipo durante el evento.',
      'Resolver imprevistos operativos.',
      'Servir de puente entre staff y productor.',
      'Verificar que cada área esté funcionando.',
      'Firmar el checklist de cierre.'
    ]},
    registration: { label: 'Registro / recepción', bullets: [
      'Recibir asistentes en la entrada principal y confirmar su registro.',
      'Escanear códigos QR de los pases con la app de staff.',
      'Entregar material impreso o acreditaciones físicas si el evento las usa.',
      'Resolver dudas básicas de los invitados y escalarlas al coordinador si es necesario.',
      'Mantener el flujo de ingreso ordenado y evitar aglomeraciones.'
    ]},
    tech: { label: 'Técnico (AV / IT)', bullets: [
      'Verificar funcionamiento de audio, video y pantallas antes del inicio.',
      'Tener cables y adaptadores de respaldo.',
      'Estar atento a la señal durante el evento.',
      'Coordinar con conferencistas por sonido o proyección.',
      'Apagar y guardar equipos al finalizar.'
    ]},
    host: { label: 'Anfitrión / hostess', bullets: [
      'Dar la bienvenida a invitados importantes.',
      'Guiar asistentes a sus zonas asignadas.',
      'Mantener la atmósfera cálida y profesional.',
      'Colaborar con registro cuando haya aglomeración.',
      'Representar al evento con amabilidad.'
    ]},
    security: { label: 'Seguridad', bullets: [
      'Controlar accesos y evitar entradas no autorizadas.',
      'Validar listas de invitados.',
      'Monitorear áreas restringidas.',
      'Coordinar con el equipo del venue.',
      'Reportar cualquier incidente al coordinador.'
    ]},
    catering: { label: 'Catering / bebidas', bullets: [
      'Montaje de la estación de catering antes del inicio.',
      'Reponer insumos durante el evento.',
      'Mantener la zona limpia y presentable.',
      'Atender restricciones alimentarias comunicadas.',
      'Desmontaje al finalizar.'
    ]},
    artistic_entertainment: { label: 'Artístico / entretenimiento', bullets: [
      'Llegar con tiempo para prueba de sonido.',
      'Coordinar entradas y salidas con el productor.',
      'Respetar los tiempos del rundown.',
      'Estar en el camerino asignado antes de su turno.',
      'Entregar el espacio limpio al terminar.'
    ]},
    other: { label: 'Otro', bullets: [] }
  },
  'en': {
    coordinator: { label: 'General coordinator', bullets: [
      'Supervise the team during the event.',
      'Resolve operational issues as they arise.',
      'Serve as the bridge between staff and producer.',
      'Verify that each area is functioning.',
      'Sign off on the closing checklist.'
    ]},
    registration: { label: 'Registration / reception', bullets: [
      'Welcome attendees at the main entrance and confirm their registration.',
      'Scan QR codes from passes with the staff app.',
      'Hand out printed materials or physical accreditations if the event uses them.',
      'Resolve basic guest questions and escalate to the coordinator if needed.',
      'Keep the entry flow orderly and prevent crowding.'
    ]},
    tech: { label: 'Technician (AV / IT)', bullets: [
      'Verify audio, video and screens before start.',
      'Keep backup cables and adapters on hand.',
      'Monitor the signal during the event.',
      'Coordinate with speakers on sound or projection.',
      'Power down and store equipment at the end.'
    ]},
    host: { label: 'Host / hostess', bullets: [
      'Welcome VIP guests.',
      'Guide attendees to their assigned areas.',
      'Keep the atmosphere warm and professional.',
      'Help registration when there is a backlog.',
      'Represent the event with warmth and professionalism.'
    ]},
    security: { label: 'Security', bullets: [
      'Control access and prevent unauthorized entry.',
      'Validate guest lists.',
      'Monitor restricted areas.',
      'Coordinate with the venue security team.',
      'Report any incident to the coordinator.'
    ]},
    catering: { label: 'Catering / beverages', bullets: [
      'Set up the catering station before start.',
      'Restock supplies during the event.',
      'Keep the area clean and presentable.',
      'Honor communicated dietary restrictions.',
      'Tear down at the end.'
    ]},
    artistic_entertainment: { label: 'Artistic / entertainment', bullets: [
      'Arrive early for sound check.',
      'Coordinate entries and exits with the producer.',
      'Respect the rundown timing.',
      'Be in the assigned dressing room before your slot.',
      'Leave the space clean when finishing.'
    ]},
    other: { label: 'Other', bullets: [] }
  },
  'pt-BR': {
    coordinator: { label: 'Coordenador geral', bullets: [
      'Supervisionar a equipe durante o evento.',
      'Resolver imprevistos operacionais.',
      'Servir de ponte entre a equipe e o produtor.',
      'Verificar que cada área está funcionando.',
      'Assinar o checklist de encerramento.'
    ]},
    registration: { label: 'Registro / recepção', bullets: [
      'Receber os participantes na entrada principal e confirmar seu registro.',
      'Escanear códigos QR dos passes com o app da equipe.',
      'Entregar material impresso ou credenciais físicas, se o evento as utilizar.',
      'Resolver dúvidas básicas dos convidados e escalá-las ao coordenador se necessário.',
      'Manter o fluxo de entrada ordenado e evitar aglomerações.'
    ]},
    tech: { label: 'Técnico (AV / TI)', bullets: [
      'Verificar o funcionamento de áudio, vídeo e telas antes do início.',
      'Ter cabos e adaptadores reserva.',
      'Ficar atento ao sinal durante o evento.',
      'Coordenar com palestrantes sobre som ou projeção.',
      'Desligar e guardar os equipamentos ao finalizar.'
    ]},
    host: { label: 'Anfitrião / recepcionista', bullets: [
      'Dar as boas-vindas a convidados VIP.',
      'Guiar os participantes às áreas atribuídas.',
      'Manter uma atmosfera acolhedora e profissional.',
      'Apoiar o registro quando houver aglomeração.',
      'Representar o evento com simpatia.'
    ]},
    security: { label: 'Segurança', bullets: [
      'Controlar acessos e evitar entradas não autorizadas.',
      'Validar listas de convidados.',
      'Monitorar áreas restritas.',
      'Coordenar com a equipe do local.',
      'Reportar qualquer incidente ao coordenador.'
    ]},
    catering: { label: 'Catering / bebidas', bullets: [
      'Montagem da estação de catering antes do início.',
      'Repor insumos durante o evento.',
      'Manter a área limpa e apresentável.',
      'Atender às restrições alimentares informadas.',
      'Desmontagem ao finalizar.'
    ]},
    artistic_entertainment: { label: 'Artístico / entretenimento', bullets: [
      'Chegar com antecedência para a passagem de som.',
      'Coordenar entradas e saídas com o produtor.',
      'Respeitar os tempos do rundown.',
      'Estar no camarim designado antes da sua apresentação.',
      'Entregar o espaço limpo ao terminar.'
    ]},
    other: { label: 'Outro', bullets: [] }
  }
};
function getRoleTemplate(locale, role) {
  const loc = normalizeLocale(locale);
  return (STAFF_ROLE_TEMPLATES_I18N[loc] && STAFF_ROLE_TEMPLATES_I18N[loc][role])
      || STAFF_ROLE_TEMPLATES_I18N[loc].other
      || STAFF_ROLE_TEMPLATES_I18N.es.other;
}
function EVTT(locale, key, vars = {}) {
  const loc = normalizeLocale(locale);
  const parts = key.split('.');
  let node = EVENTS_I18N[loc];
  for (const p of parts) { node = node && node[p]; }
  if (node == null) {
    let fb = EVENTS_I18N.es;
    for (const p of parts) { fb = fb && fb[p]; }
    node = fb || key;
  }
  return String(node).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// ── ESTILOS BASE DEL EMAIL ────────────────────────────────────
// opts.tagline permite override del subtítulo del header (ej. "Software de gestión de eventos" para Events).
// Default preserva comportamiento legacy "CMS · Pantallas Informativas" para signage/licencias.
function baseTemplate(content, opts = {}) {
  const tagline = opts.tagline || 'CMS &nbsp;·&nbsp; Pantallas Informativas';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SONORO CMS</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- HEADER -->
          <tr>
            <td style="background:#0f0f0f;padding:34px 40px 30px;text-align:center;">
              <div style="font-size:30px;font-weight:900;letter-spacing:-1.2px;color:#ffffff;line-height:1;">
                SONORO<span style="color:#FF1B8D;">.</span>
              </div>
              <div style="font-size:10px;color:#b0b0b0;letter-spacing:3px;text-transform:uppercase;margin-top:10px;font-weight:600;">
                ${tagline}
              </div>
            </td>
          </tr>

          <!-- GRAD BAR -->
          <tr>
            <td style="background:linear-gradient(135deg,#FF1B8D,#FF8C00,#FFE566);height:3px;"></td>
          </tr>

          <!-- CONTENT -->
          <tr>
            <td style="padding:40px 40px 32px;">
              ${content}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#f9f9f9;padding:24px 40px;border-top:1px solid #eee;text-align:center;">
              <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
                Este correo fue enviado por <strong style="color:#666;">SONORO CMS</strong><br>
                Si tienes dudas escríbenos a <a href="mailto:cms@sonoro.com.co" style="color:#FF1B8D;text-decoration:none;">cms@sonoro.com.co</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── EMAIL DE BIENVENIDA (S158) ────────────────────────────────
// Se envía UNA VEZ, la primera vez que el admin asigna una licencia al usuario.
// Incluye el tier asignado, la tabla comparativa de tiers, primeros pasos,
// resumen de activación del reproductor (portal cautivo S156) y contacto WhatsApp.
const TIER_LABELS = {
  cms_sencilla: 'CMS Sencilla',
  cms_doble:    'CMS Doble',
  cms_pro:      'CMS Pro',
  cms:          'CMS Sencilla',
  cms_queue:    'CMS + Atención',
  queue:        'Atención',
  rpi:          'RPi',
  windows:      'Windows'
};

async function sendWelcomeEmail(user, tier, opts = {}) {
  const tierKey   = tier || user.license_type || 'cms_sencilla';
  const tierLabel = TIER_LABELS[tierKey] || tierKey;
  const creds     = opts.credentials || null;

  const credentialsBlock = creds ? `
    <div style="background:#fff8e6;border:1px solid #f2e2b4;border-radius:10px;padding:20px 22px;margin-bottom:24px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#B57200;margin-bottom:12px;">Tus credenciales</div>
      <div style="font-size:13px;color:#333;line-height:1.7;">
        Usuario<br>
        <code style="display:inline-block;background:#fff;padding:4px 10px;border-radius:5px;font-size:14px;color:#0f0f0f;margin-bottom:10px;">${creds.email}</code><br>
        Contraseña<br>
        <code style="display:inline-block;background:#fff;padding:4px 10px;border-radius:5px;font-size:14px;font-weight:700;color:#0f0f0f;">${creds.tempPassword}</code>
      </div>
      <div style="margin-top:18px;">
        <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:12px 28px;background:#0f0f0f;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Iniciar sesión</a>
      </div>
      <div style="margin-top:14px;font-size:12px;color:#7a5a10;line-height:1.5;">
        Podés cambiar la contraseña cuando quieras desde <strong>Mi cuenta</strong>. Guardala en un lugar seguro.
      </div>
    </div>
  ` : '';

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;letter-spacing:-0.3px;">
      Bienvenido a SONORO CMS
    </h1>
    <p style="margin:0 0 26px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || 'de nuevo'}</strong>, tu cuenta ya está activa.
    </p>

    ${credentialsBlock}

    <p style="margin:0 0 28px;font-size:13px;color:#666;line-height:1.6;">
      Tu plan: <strong style="color:#0f0f0f;">${tierLabel}</strong> · 500 MB de almacenamiento.
    </p>

    <p style="margin:0 0 24px;font-size:13px;color:#666;line-height:1.6;">
      Cuando generes tu primer código de activación desde el CMS, te enviaremos por correo la guía paso a paso para conectar el reproductor.
    </p>

    <div style="margin:32px 0 8px;padding-top:20px;border-top:1px solid #eee;font-size:12.5px;color:#666;line-height:1.6;">
      ¿Necesitás más espacio o ampliar tu plan? Escribinos por WhatsApp al
      <a href="https://wa.me/573144460990" style="color:#0f0f0f;text-decoration:none;font-weight:700;">+57 314 446 0990</a>.
    </div>
  `);

  await transporter.sendMail({
    from:    FROM,
    to:      user.email,
    subject: 'Tu cuenta SONORO CMS está lista',
    html
  });

  console.log(`✅ Email de bienvenida enviado a ${user.email} (${tierKey})`);
}

// ── EMAIL DE REPRODUCTOR ACTIVADO ────────────────────────────
async function sendDeviceActivatedEmail(user, device) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Reproductor activado
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>, 
      tu reproductor ha sido vinculado correctamente a tu cuenta.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #eee;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Nombre</p>
          <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${device.name || device.device_id}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #eee;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">ID del reproductor</p>
          <p style="margin:0;font-size:13px;color:#666;font-family:monospace;">${device.device_id}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Dirección IP</p>
          <p style="margin:0;font-size:13px;color:#666;font-family:monospace;">${device.ip_address || '—'}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Ahora puedes asignarle una lista de reproducción desde el CMS y comenzará a reproducir tu contenido automáticamente.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
            Gestionar reproductor
          </a>
        </td>
      </tr>
    </table>
  `);

  await transporter.sendMail({
    from:    FROM,
    to:      user.email,
    subject: `Reproductor "${device.name || device.device_id}" activado`,
    html
  });

  console.log(`✅ Email de activación enviado a ${user.email}`);
}

// ── EMAIL: GUÍA DE ACTIVACIÓN DEL REPRODUCTOR (S158f) ─────────
// Se dispara automáticamente la primera vez que el usuario genera un código
// de activación. Replica el paso a paso del modal en dashboard.html.
async function sendActivationGuideEmail(user) {
  const step = (n, title, body, active) => `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #eee;vertical-align:top;">
        <table cellpadding="0" cellspacing="0" width="100%"><tr>
          <td width="36" style="vertical-align:top;">
            <div style="width:28px;height:28px;border-radius:50%;${active
              ? 'background:#0f0f0f;color:#fff;'
              : 'background:#f0f0f0;color:#0f0f0f;border:1px solid #ddd;'}text-align:center;line-height:28px;font-size:12px;font-weight:800;">${n}</div>
          </td>
          <td style="vertical-align:top;padding-left:2px;">
            <div style="font-size:14px;font-weight:700;color:#0f0f0f;margin-bottom:4px;line-height:1.4;">${title}</div>
            <div style="font-size:13px;color:#666;line-height:1.6;">${body}</div>
          </td>
        </tr></table>
      </td>
    </tr>
  `;
  const code = txt => `<code style="background:#f4f4f4;padding:1px 6px;border-radius:4px;font-family:'Courier New',monospace;font-size:12.5px;color:#0f0f0f;border:1px solid #e4e4e4;">${txt}</code>`;

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;letter-spacing:-0.3px;">
      Activá tu reproductor SONORO
    </h1>
    <p style="margin:0 0 28px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || 'de nuevo'}</strong>. Ya generaste tu primer código de activación.
      Estos son los 5 pasos para conectar el reproductor desde el celular. El código dura 7 días y se usa una sola vez.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:26px;">
      ${step(1, 'Conectá el reproductor al TV',
        'Enchufá la corriente y el cable HDMI al televisor. Esperá unos 30 segundos.', true)}
      ${step(2, 'Buscá la red WiFi que crea el reproductor',
        `En tu celular, abrí Ajustes de WiFi y conectate a la red que empieza por ${code('SCMS-')} (ej. ${code('SCMS-RO01AB')}).<br>Contraseña: ${code('sonorocms')}`, false)}
      ${step(3, 'Abrí el portal de configuración',
        `En <strong style="color:#0f0f0f;">iPhone</strong> el portal se abre solo. En <strong style="color:#0f0f0f;">Android</strong> aparece una notificación "Iniciar sesión en la red WiFi"; si no aparece, abrí el navegador y entrá a ${code('http://10.42.0.1:8080')}.`, false)}
      ${step(4, 'Seleccioná la red WiFi del sitio',
        'En el portal, elegí la red WiFi del cliente e ingresá su contraseña. Si el reproductor está por cable de red, salta este paso.', false)}
      ${step(5, 'Ingresá el código de activación',
        'Pegá el código que generaste en el CMS. El reproductor se registrará solo y aparecerá en <strong style="color:#0f0f0f;">Pantallas</strong> en menos de un minuto.', false)}
    </table>

    <div style="background:#f9f9f9;border-radius:8px;padding:14px 18px;margin-bottom:28px;font-size:12.5px;color:#555;line-height:1.6;">
      <strong style="color:#0f0f0f;">Si el portal no se abre solo en Android:</strong> abrí el navegador manualmente y entrá a
      ${code('http://10.42.0.1:8080')}. Es normal en algunos modelos y no afecta la activación.
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:12px 28px;background:#0f0f0f;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">Ver mis códigos</a>
    </div>

    <div style="padding-top:20px;border-top:1px solid #eee;font-size:12.5px;color:#666;line-height:1.6;">
      ¿Se trabó algo? Escribinos por WhatsApp al
      <a href="https://wa.me/573144460990" style="color:#0f0f0f;text-decoration:none;font-weight:700;">+57 314 446 0990</a>.
    </div>
  `);

  await transporter.sendMail({
    from:    FROM,
    to:      user.email,
    subject: 'Guía para activar tu reproductor SONORO',
    html
  });

  console.log(`✅ Guía de activación enviada a ${user.email}`);
}

// ── VERIFICAR CONEXIÓN SMTP ───────────────────────────────────
async function verifyConnection() {
  try {
    await transporter.verify();
    console.log('✅ Servidor SMTP conectado');
    return true;
  } catch(e) {
    console.warn('⚠️ SMTP no disponible:', e.message);
    return false;
  }
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendActivationGuideEmail, verifyConnection };

// ── EMAIL: LICENCIA RENOVADA ──────────────────────────────────
async function sendLicenseRenewedEmail(user, license) {
  const endDate = new Date(license.new_end).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const typeLabel = license.license_type === 'windows' ? 'Windows' : 'Raspberry Pi';

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Licencia renovada
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>,
      tu licencia ha sido renovada exitosamente.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tipo de licencia</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${typeLabel}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Período renovado</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${license.months} ${license.months === 1 ? 'mes' : 'meses'}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Nuevo vencimiento</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${endDate}</p>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Ir al CMS
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM, to: user.email,
    subject: 'Licencia SONORO CMS renovada',
    html
  });
  console.log(`✅ Email de renovación enviado a ${user.email}`);
}

// ── EMAIL: AVISO DE VENCIMIENTO ───────────────────────────────
async function sendLicenseExpiringEmail(user, daysLeft) {
  const endDate = new Date(user.license_end).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });
  const isUrgent = daysLeft <= 7;

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ${isUrgent ? '⚠️ Tu licencia vence pronto' : 'Aviso de vencimiento de licencia'}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>,
      tu licencia de SONORO CMS vence en <strong style="color:${isUrgent ? '#FF1B8D' : '#FF8C00'};">${daysLeft} días</strong> (${endDate}).
    </p>
    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      Cuando la licencia venza, el acceso al CMS será bloqueado y tus reproductores mostrarán la pantalla de SONORO en espera.
      Para renovar, contáctanos a <a href="mailto:${FROM}" style="color:#FF1B8D;">${process.env.SMTP_USER}</a>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="mailto:${process.env.SMTP_USER}?subject=Renovación licencia SONORO CMS" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Solicitar renovación
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM, to: user.email,
    subject: `Tu licencia SONORO CMS vence en ${daysLeft} días`,
    html
  });
  console.log(`✅ Aviso de vencimiento enviado a ${user.email} (${daysLeft} días)`);
}


// ── EMAIL: CREDENCIALES DE AGENTE ────────────────────────────
async function sendAgentCredentialsEmail(agent, branch, cmsUrl) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      Bienvenido al sistema de Atención al Usuario
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${agent.name}</strong>,
      has sido registrado como agente de atención en <strong style="color:#0f0f0f;">${branch.name}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:28px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Sucursal</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${branch.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tu nombre</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${agent.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Tu PIN de acceso</p>
        <p style="margin:0;font-size:28px;color:#FF1B8D;font-weight:900;letter-spacing:8px;">${agent.pin}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Panel de acceso</p>
        <p style="margin:0;font-size:13px;color:#0f0f0f;font-family:monospace;">${cmsUrl}/atencion/agente</p>
      </td></tr>
    </table>
    <p style="margin:0 0 24px;font-size:13px;color:#888;line-height:1.6;">
      Abre el enlace en tu navegador, selecciona la sucursal <strong>${branch.name}</strong>, 
      tu nombre y escribe tu PIN para iniciar sesión en tu ventanilla.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <a href="${cmsUrl}/atencion/agente" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Ir al panel de agente
        </a>
      </td></tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM,
    to: agent.email,
    subject: `Tus credenciales de acceso — SONORO Atención al Usuario`,
    html
  });
  console.log(`✅ Credenciales enviadas a ${agent.email}`);
}

// ── ALERTA CEC — TV apagada en ventana programada ────────────
async function sendCecAlertEmail(user, device, schedule) {
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      ⚠️ TV apagada en horario programado
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || user.email}</strong>, uno de tus reproductores
      tiene la TV <strong style="color:#cc0000;">apagada</strong> durante una ventana programada.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8f8;border:1px solid #ffcccc;border-radius:8px;margin-bottom:24px;">
      <tr>
        <td style="padding:20px 24px;">
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Dispositivo</p>
          <p style="margin:0 0 16px;font-size:16px;color:#0f0f0f;font-weight:700;">${device.name || device.device_id}</p>
          <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Ventana programada</p>
          <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${schedule.time_on} – ${schedule.time_off}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
      Verifica que la TV esté encendida o usa el panel de control para enviarle el comando de encendido.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:#fff;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">
            Ir al dashboard
          </a>
        </td>
      </tr>
    </table>
  `);

  await transporter.sendMail({
    from: FROM,
    to: user.email,
    subject: `⚠️ TV apagada — ${device.name || device.device_id}`,
    html
  });
  console.log(`✅ CEC alert email enviado a ${user.email} — device: ${device.name}`);
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendLicenseRenewedEmail, sendLicenseExpiringEmail, sendAgentCredentialsEmail, sendCecAlertEmail, verifyConnection };

// ── EMAIL BULK PUSH REPORT ────────────────────────────────────
async function sendBulkPushReport(emails, summary) {
  const { playlist_name, total, updated, notified, errors, filters, timestamp } = summary;
  const date = new Date(timestamp).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const filterDesc = [
    filters.city        ? `Ciudad: <strong>${filters.city}</strong>` : null,
    filters.branch_id   ? `Sede específica` : null,
    filters.orientation ? `Formato: <strong>${filters.orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}</strong>` : null,
  ].filter(Boolean).join(' · ') || 'Todos los dispositivos';

  const errorsHtml = errors.length
    ? `<div style="margin-top:16px;padding:12px 16px;background:#fff3f3;border-left:3px solid #ff1744;border-radius:4px;">
        <div style="font-size:12px;font-weight:700;color:#ff1744;margin-bottom:6px;">Errores (${errors.length})</div>
        ${errors.map(e => `<div style="font-size:12px;color:#666;">${e.device_id}: ${e.error}</div>`).join('')}
       </div>` : '';

  const html = baseTemplate(`
    <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;color:#0f0f0f;">Bulk Push completado</h2>
    <p style="margin:0 0 24px;font-size:13px;color:#888;">${date}</p>

    <div style="background:#f9f9f9;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Playlist enviada</div>
      <div style="font-size:16px;font-weight:800;color:#0f0f0f;">${playlist_name}</div>
      <div style="font-size:12px;color:#888;margin-top:4px;">Filtro aplicado: ${filterDesc}</div>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:12px 16px;background:#f4f4f4;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#0f0f0f;">${total}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Dispositivos</div>
        </td>
        <td width="10"></td>
        <td style="padding:12px 16px;background:#f0fff8;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#00c853;">${updated}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Actualizados</div>
        </td>
        <td width="10"></td>
        <td style="padding:12px 16px;background:#f0f8ff;border-radius:8px;text-align:center;width:33%;">
          <div style="font-size:24px;font-weight:900;color:#2196f3;">${notified}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;">Notificados</div>
        </td>
      </tr>
    </table>

    <p style="font-size:12px;color:#999;margin:0 0 4px;">
      Los dispositivos offline aplicarán el cambio automáticamente al reconectarse.
    </p>
    ${errorsHtml}
  `);

  for (const email of emails) {
    await transporter.sendMail({
      from: FROM,
      to: email,
      subject: `Bulk Push completado — ${playlist_name} · ${updated}/${total} dispositivos`,
      html
    });
    console.log(`✅ Reporte Bulk Push enviado a ${email}`);
  }
}


async function sendPasswordResetEmail(user, resetLink) {
  const html = baseTemplate(`
    <h2 style="margin:0 0 6px;font-size:20px;font-weight:800;color:#0f0f0f;">Restablecer contraseña</h2>
    <p style="margin:0 0 24px;font-size:13px;color:#888;">Hola ${user.name || user.email}, recibimos una solicitud para restablecer tu contraseña.</p>

    <div style="background:#f9f9f9;border-radius:8px;padding:20px;margin-bottom:24px;text-align:center;">
      <p style="margin:0 0 16px;font-size:14px;color:#555;">Haz clic en el botón para crear una nueva contraseña. Este enlace es válido por <strong>1 hora</strong>.</p>
      <a href="${resetLink}"
         style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#7b61ff,#00f5d4);color:#fff;font-weight:800;font-size:14px;text-decoration:none;border-radius:8px;letter-spacing:0.5px;">
        Restablecer contraseña
      </a>
    </div>

    <p style="font-size:12px;color:#999;margin:0 0 8px;">Si no solicitaste este cambio, ignora este correo. Tu contraseña no será modificada.</p>
    <p style="font-size:11px;color:#bbb;margin:0;">
      Si el botón no funciona, copia este enlace en tu navegador:<br>
      <span style="color:#7b61ff;word-break:break-all;">${resetLink}</span>
    </p>
  `);
  await transporter.sendMail({
    from: FROM,
    to: user.email,
    subject: 'Restablecer contraseña — SONORO CMS',
    html
  });
  console.log(`✅ Email reset password enviado a ${user.email}`);
}

// ── EMAIL: INSCRIPCIÓN RECIBIDA (pendiente de confirmación) ──
async function sendEventPendingEmail(attendee, event, emailConfig = {}) {
  const loc = normalizeLocale(attendee.locale);
  const opts = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString(localeDateFmt(loc), opts);

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ${EVTT(loc, 'pending.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'pending.intro', { name: attendee.name, event: event.name })}
    </p>

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
        ${EVTT(loc, 'pending.note')}
      </p>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'pending.lbl_event')}</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'pending.lbl_date')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      ${event.venue_name ? `
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'pending.lbl_venue')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${event.venue_name}</p>
      </td></tr>` : ''}
    </table>

    <p style="margin:0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      ${EVTT(loc, 'pending.disclaimer')}
    </p>
  `, { tagline: EVTT(loc, 'pending.tagline') });

  const _fromPend = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moP = { from: _fromPend, to: attendee.email, subject: EVTT(loc, 'pending.subject', { event: event.name }), html };
  if (emailConfig.reply_to) moP.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moP);
  console.log(`✅ Email inscripción pendiente enviado a ${attendee.email} [${loc}]`);
}

// ── EMAIL DE CONFIRMACIÓN DE REGISTRO A EVENTO ───────────────
async function sendEventRegistrationEmail(attendee, event, registration, emailConfig = {}) {
  const loc = normalizeLocale(attendee.locale);
  const QRCode  = require('qrcode');
  const qrLink  = `${CMS_URL}/evento/${event.slug}/mi-registro/${registration.qr_token}`;
  const opts    = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString(localeDateFmt(loc), opts);
  const endStr   = new Date(event.ends_at).toLocaleString(localeDateFmt(loc), opts);
  const ticketLabel = (registration.ticket_type || 'general').charAt(0).toUpperCase() + (registration.ticket_type || 'general').slice(1);

  let qrImgHtml = `<p style="margin:0;font-family:monospace;font-size:12px;color:#555;word-break:break-all;">${registration.qr_token}</p>`;
  let attachments = [];
  try {
    const qrBuffer = await QRCode.toBuffer(registration.qr_token, { type: 'png', width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    qrImgHtml = `<img src="cid:event_qr_code" alt="${EVTT(loc, 'registration.qr_alt')}" width="200" height="200" style="display:block;margin:0 auto;" />`;
    attachments = [{ filename: 'qr.png', content: qrBuffer, cid: 'event_qr_code' }];
  } catch (e) {
    console.error('⚠️ QR generation error:', e.message);
  }

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;">
      ${EVTT(loc, 'registration.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'registration.intro', { name: attendee.name })}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'registration.lbl_event')}</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'registration.lbl_start')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'registration.lbl_end')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${endStr}</p>
      </td></tr>
      ${event.venue_name ? `
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'registration.lbl_venue')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${event.venue_name}</p>
      </td></tr>` : ''}
      <tr><td style="padding:16px 24px;${event.registration_mode === 'full_event' ? 'border-bottom:1px solid #eee;' : ''}">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'registration.lbl_ticket')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${ticketLabel}</p>
      </td></tr>
      ${event.registration_mode === 'full_event' ? `
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${loc === 'en' ? 'Sessions' : (loc === 'pt-BR' ? 'Sessões' : 'Sesiones')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${loc === 'en' ? 'All event sessions' : (loc === 'pt-BR' ? 'Todas as sessões do evento' : 'Todas las sesiones del evento')}</p>
      </td></tr>` : ''}
    </table>

    <div style="text-align:center;margin:24px 0;background:#fff;border:1px solid #eee;border-radius:8px;padding:20px;">
      <p style="margin:0 0 12px;font-size:13px;color:#666;font-weight:600;">
        ${EVTT(loc, 'registration.qr_prompt')}
      </p>
      ${qrImgHtml}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${qrLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          ${EVTT(loc, 'registration.cta')}
        </a>
      </td></tr>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      ${EVTT(loc, 'registration.disclaimer')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });

  const _fromReg = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moR = { from: _fromReg, to: attendee.email, subject: EVTT(loc, 'registration.subject', { event: event.name }), html, attachments };
  if (emailConfig.reply_to) moR.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moR);
  console.log(`✅ Email de registro de evento enviado a ${attendee.email} [${loc}]`);
}

// ── SOLICITUD DE COTIZACIÓN A PROVEEDOR ──────────────────────
async function sendSupplierQuoteEmail({ supplier_name, contact_email, event_name, starts_at, timezone, service_description, locale }, quoteUrl, emailConfig = {}) {
  const loc = normalizeLocale(locale);
  const dateStr = starts_at
    ? new Date(starts_at).toLocaleDateString(localeDateFmt(loc), { day: '2-digit', month: 'long', year: 'numeric', timeZone: timezone || 'America/Bogota' })
    : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      ${EVTT(loc, 'supplier_quote.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'supplier_quote.intro', { name: supplier_name })}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_quote.lbl_event')}</p>
        <p style="margin:0 0 12px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${dateStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_quote.lbl_date')}</p>
        <p style="margin:0 0 12px;font-size:14px;color:#333;">${dateStr}</p>` : ''}
        ${service_description ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_quote.lbl_service')}</p>
        <p style="margin:0;font-size:14px;color:#333;">${service_description}</p>` : ''}
      </td></tr>
    </table>

    <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">
      ${EVTT(loc, 'supplier_quote.body')}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${quoteUrl}" style="display:inline-block;padding:14px 40px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
          ${EVTT(loc, 'supplier_quote.cta')} <svg viewBox="0 0 256 256" width="14" height="14" fill="currentColor" style="vertical-align:middle;margin-left:6px;"><path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z"/></svg>
        </a>
      </td></tr>
    </table>

    <p style="margin:0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      ${EVTT(loc, 'supplier_quote.single_use', { name: supplier_name })}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });
  const _fromQ = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moQ = { from: _fromQ, to: contact_email, subject: EVTT(loc, 'supplier_quote.subject', { event: event_name }), html };
  if (emailConfig.reply_to) moQ.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moQ);
  console.log(`✅ Email cotización enviado a ${contact_email} (${event_name}) [${loc}]`);
}

async function sendSupplierAcceptedEmail({ supplier_name, contact_email, event_name, contracted_amount, locale }, emailConfig = {}) {
  const loc = normalizeLocale(locale);
  const amountStr = contracted_amount
    ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(contracted_amount)
    : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">
      ${EVTT(loc, 'supplier_accepted.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'supplier_accepted.intro', { name: supplier_name })}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_accepted.lbl_event')}</p>
        <p style="margin:0 0 12px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${amountStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_accepted.lbl_amount')}</p>
        <p style="margin:0;font-size:15px;color:#22c55e;font-weight:700;">${amountStr}</p>` : ''}
      </td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      ${EVTT(loc, 'supplier_accepted.closing')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });
  const _fromA = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const moA = { from: _fromA, to: contact_email, subject: EVTT(loc, 'supplier_accepted.subject', { event: event_name }), html };
  if (emailConfig.reply_to) moA.replyTo = emailConfig.reply_to;
  await transporter.sendMail(moA);
  console.log(`✅ Email aceptación enviado a ${contact_email} (${event_name}) [${loc}]`);
}


// ── ABONO A PROVEEDOR ────────────────────────────────────────
async function sendSupplierDepositEmail({ supplier_name, contact_email, event_name, deposit_amount, contracted_amount, payment_proof_url, locale }, emailConfig = {}) {
  const loc = normalizeLocale(locale);
  const fmtCOP = n => n != null ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n) : '';
  const depositStr  = fmtCOP(deposit_amount);
  const pendingAmt  = (contracted_amount != null && deposit_amount != null) ? contracted_amount - deposit_amount : null;
  const pendingStr  = fmtCOP(pendingAmt);
  const proofLine   = payment_proof_url ? `<p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">${EVTT(loc, 'supplier_deposit.proof_note')}</p>` : '';
  const pendingLine = pendingAmt != null ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_deposit.lbl_pending')}</p><p style="margin:0;font-size:15px;color:#f59e0b;font-weight:700;">${pendingStr}</p>` : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">${EVTT(loc, 'supplier_deposit.h1')}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'supplier_deposit.intro', { name: supplier_name })}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_deposit.lbl_event')}</p>
        <p style="margin:0 0 14px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_deposit.lbl_received')}</p>
        <p style="margin:0 0 14px;font-size:18px;color:#3b82f6;font-weight:800;">${depositStr}</p>
        ${pendingLine}
      </td></tr>
    </table>
    ${proofLine}
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      ${EVTT(loc, 'supplier_deposit.closing')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });
  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: contact_email, subject: EVTT(loc, 'supplier_deposit.subject', { event: event_name }), html };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  if (payment_proof_url) {
    const filePath = path.join(__dirname, '../public', payment_proof_url);
    if (fs.existsSync(filePath)) {
      mo.attachments = [{ filename: 'comprobante_abono.pdf', path: filePath }];
    }
  }
  await transporter.sendMail(mo);
  console.log(`✅ Email abono enviado a ${contact_email} (${event_name})`);
}

// ── PAGO COMPLETO A PROVEEDOR ────────────────────────────────
async function sendSupplierPaidEmail({ supplier_name, contact_email, event_name, contracted_amount, payment_proof_url, locale }, emailConfig = {}) {
  const loc = normalizeLocale(locale);
  const amountStr = contracted_amount != null ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(contracted_amount) : '';
  const proofLine = payment_proof_url ? `<p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.6;">${EVTT(loc, 'supplier_paid.proof_note')}</p>` : '';
  const amountLine = amountStr ? `<p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_paid.lbl_total')}</p><p style="margin:0;font-size:18px;color:#10b981;font-weight:800;">${amountStr}</p>` : '';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f0f0f;">${EVTT(loc, 'supplier_paid.h1')}</h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'supplier_paid.intro', { name: supplier_name })}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'supplier_paid.lbl_event')}</p>
        <p style="margin:0 0 14px;font-size:16px;color:#0f0f0f;font-weight:700;">${event_name}</p>
        ${amountLine}
      </td></tr>
    </table>
    ${proofLine}
    <p style="margin:0;font-size:14px;color:#555;line-height:1.6;">
      ${EVTT(loc, 'supplier_paid.closing')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });
  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: contact_email, subject: EVTT(loc, 'supplier_paid.subject', { event: event_name }), html };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  if (payment_proof_url) {
    const filePath = path.join(__dirname, '../public', payment_proof_url);
    if (fs.existsSync(filePath)) {
      mo.attachments = [{ filename: 'comprobante_pago_final.pdf', path: filePath }];
    }
  }
  await transporter.sendMail(mo);
  console.log(`✅ Email pago completo enviado a ${contact_email} (${event_name})`);
}

// ── EMAIL DE INVITACIÓN CONFIRMADA (TALENTO/PRENSA/PONENTE) ─────────────────
async function sendInvitationConfirmedEmail(attendee, event, registration, batch, emailConfig = {}) {
  const loc = normalizeLocale(attendee.locale);
  const QRCode  = require('qrcode');
  const qrLink  = `${CMS_URL}/evento/${event.slug}/mi-registro/${registration.qr_token}`;
  const opts    = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString(localeDateFmt(loc), opts);
  const endStr   = new Date(event.ends_at).toLocaleString(localeDateFmt(loc), opts);
  const roleLabel = (registration.ticket_type || batch.ticket_type || 'talent').charAt(0).toUpperCase() + (registration.ticket_type || batch.ticket_type || 'talent').slice(1);

  let qrImgHtml = `<p style="margin:0;font-family:monospace;font-size:12px;color:#555;word-break:break-all;">${registration.qr_token}</p>`;
  let attachments = [];
  try {
    const qrBuffer = await QRCode.toBuffer(registration.qr_token, { type: 'png', width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    qrImgHtml = `<img src="cid:event_qr_code" alt="QR" width="200" height="200" style="display:block;margin:0 auto;" />`;
    attachments = [{ filename: 'qr.png', content: qrBuffer, cid: 'event_qr_code' }];
  } catch (e) {
    console.error('⚠️ QR generation error:', e.message);
  }

  const html = baseTemplate(`
    <div style="text-align:center;margin:0 0 16px;">
      <span style="display:inline-block;padding:6px 14px;background:#fdf6e3;color:#b8862b;border:1px solid #e7c97a;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">
        ${roleLabel} · ${EVTT(loc, 'invitation_confirmed.badge_suffix')}
      </span>
    </div>
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;text-align:center;">
      ${EVTT(loc, 'invitation_confirmed.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;text-align:center;">
      ${EVTT(loc, 'invitation_confirmed.intro', { name: attendee.name, event: event.name })}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_confirmed.lbl_event')}</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_confirmed.lbl_start')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_confirmed.lbl_end')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${endStr}</p>
      </td></tr>
      ${event.venue_name ? `
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_confirmed.lbl_venue')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${event.venue_name}</p>
      </td></tr>` : ''}
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_confirmed.lbl_credential')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${batch.label}</p>
      </td></tr>
    </table>

    ${batch.notes ? `
    <div style="background:#fdf6e3;border-left:3px solid #b8862b;border-radius:6px;padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#b8862b;">${EVTT(loc, 'invitation_confirmed.notes_header')}</p>
      <p style="margin:0;font-size:13px;color:#5b4516;line-height:1.6;white-space:pre-wrap;">${batch.notes}</p>
    </div>` : ''}

    <div style="text-align:center;margin:24px 0;background:#fff;border:1px solid #eee;border-radius:8px;padding:20px;">
      <p style="margin:0 0 12px;font-size:13px;color:#666;font-weight:600;">
        ${EVTT(loc, 'invitation_confirmed.qr_prompt')}
      </p>
      ${qrImgHtml}
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td align="center">
        <a href="${qrLink}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#b8862b,#e7c97a);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          ${EVTT(loc, 'invitation_confirmed.cta')}
        </a>
      </td></tr>
    </table>

    <p style="margin:24px 0 0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      ${EVTT(loc, 'invitation_confirmed.disclaimer')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });

  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: attendee.email, subject: EVTT(loc, 'invitation_confirmed.subject', { event: event.name }), html, attachments };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  await transporter.sendMail(mo);
  console.log(`✅ Email invitación confirmada enviado a ${attendee.email} [${loc}]`);
}

// ── EMAIL DE INVITACIÓN PENDIENTE DE APROBACIÓN ─────────────────────────────
async function sendInvitationPendingEmail(attendee, event, batch, emailConfig = {}) {
  const loc = normalizeLocale(attendee.locale);
  const opts = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString(localeDateFmt(loc), opts);
  const roleLabel = (batch.ticket_type || 'talent').charAt(0).toUpperCase() + (batch.ticket_type || 'talent').slice(1);

  const html = baseTemplate(`
    <div style="text-align:center;margin:0 0 16px;">
      <span style="display:inline-block;padding:6px 14px;background:#fdf6e3;color:#b8862b;border:1px solid #e7c97a;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">
        ${roleLabel} · ${EVTT(loc, 'invitation_pending.badge_suffix')}
      </span>
    </div>
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;text-align:center;">
      ${EVTT(loc, 'invitation_pending.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;text-align:center;">
      ${EVTT(loc, 'invitation_pending.intro', { name: attendee.name, event: event.name })}
    </p>

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0;font-size:13px;color:#92400e;line-height:1.6;">
        ${EVTT(loc, 'invitation_pending.note')}
      </p>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_pending.lbl_event')}</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_pending.lbl_date')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'invitation_pending.lbl_credential')}</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${batch.label}</p>
      </td></tr>
    </table>

    ${batch.notes ? `
    <div style="background:#fdf6e3;border-left:3px solid #b8862b;border-radius:6px;padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#b8862b;">${EVTT(loc, 'invitation_pending.notes_header')}</p>
      <p style="margin:0;font-size:13px;color:#5b4516;line-height:1.6;white-space:pre-wrap;">${batch.notes}</p>
    </div>` : ''}

    <p style="margin:0;font-size:11px;color:#bbb;text-align:center;line-height:1.6;">
      ${EVTT(loc, 'invitation_pending.disclaimer')}
    </p>
  `, { tagline: EVTT(loc, 'tagline') });

  const _from = emailConfig.from_name ? `"${emailConfig.from_name}" <${process.env.SMTP_USER || 'cms@sonoro.com.co'}>` : FROM;
  const mo = { from: _from, to: attendee.email, subject: EVTT(loc, 'invitation_pending.subject', { event: event.name }), html };
  if (emailConfig.reply_to) mo.replyTo = emailConfig.reply_to;
  await transporter.sendMail(mo);
  console.log(`✅ Email invitación pendiente enviado a ${attendee.email} [${loc}]`);
}

// ── TEMPLATES FIJOS DE RESPONSABILIDADES POR ROL (S208j) ─────────────────────
const STAFF_ROLE_TEMPLATES = {
  coordinator: {
    label: 'Coordinador general',
    bullets: [
      'Supervisar al equipo durante el evento.',
      'Resolver imprevistos operativos.',
      'Servir de puente entre staff y productor.',
      'Verificar que cada área esté funcionando.',
      'Firmar el checklist de cierre.',
    ],
  },
  registration: {
    label: 'Registro / recepción',
    bullets: [
      'Recibir asistentes en la entrada principal y confirmar su registro.',
      'Escanear códigos QR de los pases con la app de staff.',
      'Entregar material impreso o acreditaciones físicas si el evento las usa.',
      'Resolver dudas básicas de los invitados y escalarlas al coordinador si es necesario.',
      'Mantener el flujo de ingreso ordenado y evitar aglomeraciones.',
    ],
  },
  tech: {
    label: 'Técnico (AV / IT)',
    bullets: [
      'Verificar funcionamiento de audio, video y pantallas antes del inicio.',
      'Tener cables y adaptadores de respaldo.',
      'Estar atento a la señal durante el evento.',
      'Coordinar con conferencistas por sonido o proyección.',
      'Apagar y guardar equipos al finalizar.',
    ],
  },
  host: {
    label: 'Anfitrión / hostess',
    bullets: [
      'Dar la bienvenida a invitados importantes.',
      'Guiar asistentes a sus zonas asignadas.',
      'Mantener la atmósfera cálida y profesional.',
      'Colaborar con registro cuando haya aglomeración.',
      'Representar al evento con amabilidad.',
    ],
  },
  security: {
    label: 'Seguridad',
    bullets: [
      'Controlar accesos y evitar entradas no autorizadas.',
      'Validar listas de invitados.',
      'Monitorear áreas restringidas.',
      'Coordinar con el equipo del venue.',
      'Reportar cualquier incidente al coordinador.',
    ],
  },
  catering: {
    label: 'Catering / bebidas',
    bullets: [
      'Montaje de la estación de catering antes del inicio.',
      'Reponer insumos durante el evento.',
      'Mantener la zona limpia y presentable.',
      'Atender restricciones alimentarias comunicadas.',
      'Desmontaje al finalizar.',
    ],
  },
  artistic_entertainment: {
    label: 'Artístico / entretenimiento',
    bullets: [
      'Llegar con tiempo para prueba de sonido.',
      'Coordinar entradas y salidas con el productor.',
      'Respetar los tiempos del rundown.',
      'Estar en el camerino asignado antes de su turno.',
      'Entregar el espacio limpio al terminar.',
    ],
  },
  other: {
    label: 'Otro',
    bullets: [],
  },
};

// ── EMAIL #1 STAFF — CREDENCIALES DE ACCESO (S208j) ──────────────────────────
async function sendStaffCredentialsEmail(staff, event, producer) {
  if (!staff || !staff.email) {
    console.log('⚠️ Staff sin email, skip credentials');
    return;
  }
  const loc = normalizeLocale(staff.locale);
  const tpl = getRoleTemplate(loc, staff.role);
  const roleLabel = tpl.label;
  const opts = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const startStr = new Date(event.starts_at).toLocaleString(localeDateFmt(loc), opts);
  const producerName  = (producer && producer.name)  || EVTT(loc, 'staff_credentials.producer_fallback');
  const producerEmail = (producer && producer.email) || 'cms@sonoro.com.co';
  const venueLine = event.venue_name
    ? (event.venue_address ? `${event.venue_name} · ${event.venue_address}` : event.venue_name)
    : '—';
  const panelUrl = `${CMS_URL}/evento/${event.slug}/staff`;

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;line-height:1.25;">
      ${EVTT(loc, 'staff_credentials.h1')}
    </h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'staff_credentials.intro', { name: staff.name, producer: producerName, event: event.name, role: roleLabel })}
    </p>

    <div style="background:#0f0f0f;border-radius:10px;padding:22px;text-align:center;margin:0 0 24px;">
      <div style="font-size:10px;letter-spacing:3px;color:#b0b0b0;font-weight:700;margin-bottom:10px;text-transform:uppercase;">${EVTT(loc, 'staff_credentials.pin_label')}</div>
      <div style="font-family:ui-monospace,monospace;font-weight:900;font-size:36px;line-height:1;color:#FFE566;letter-spacing:8px;">${staff.pin}</div>
    </div>

    <p style="margin:0 0 24px;font-size:14px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'staff_credentials.pin_help')}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${panelUrl}" style="display:inline-block;padding:14px 26px;background:#0f0f0f;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
          ${EVTT(loc, 'staff_credentials.cta')}
        </a>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_credentials.lbl_event')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${event.name}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_credentials.lbl_date')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_credentials.lbl_venue')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${venueLine}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_credentials.lbl_producer')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${producerName} · ${producerEmail}</p>
      </td></tr>
    </table>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin:0 0 8px;">
      <p style="margin:0;font-size:13px;color:#1e3a8a;line-height:1.55;">
        ${EVTT(loc, 'staff_credentials.briefing_note')}
      </p>
    </div>
  `, { tagline: EVTT(loc, 'tagline') });

  await transporter.sendMail({
    from: FROM,
    to: staff.email,
    subject: EVTT(loc, 'staff_credentials.subject', { event: event.name }),
    html
  });
  console.log(`✅ Credenciales staff enviadas a ${staff.email} (${event.name}) [${loc}]`);
}

// ── EMAIL #2 STAFF — BRIEFING DE RESPONSABILIDADES (S208j) ───────────────────
async function sendStaffBriefingEmail(staff, event, producer) {
  if (!staff || !staff.email) {
    console.log('⚠️ Staff sin email, skip briefing');
    return;
  }
  const loc = normalizeLocale(staff.locale);
  const tpl = getRoleTemplate(loc, staff.role);
  const roleLabel = tpl.label;
  const opts = { timeZone: event.timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
  const dateFmt = localeDateFmt(loc);
  const startStr   = new Date(event.starts_at).toLocaleString(dateFmt, opts);
  const arrivalAt  = new Date(new Date(event.starts_at).getTime() - 60 * 60 * 1000);
  const arrivalStr = arrivalAt.toLocaleString(dateFmt, opts);
  const producerName  = (producer && producer.name)  || EVTT(loc, 'staff_briefing.producer_fallback');
  const producerEmail = (producer && producer.email) || 'cms@sonoro.com.co';
  const venueLine = event.venue_name
    ? (event.venue_address ? `${event.venue_name} · ${event.venue_address}` : event.venue_name)
    : '—';
  const panelUrl = `${CMS_URL}/evento/${event.slug}/staff`;

  const hasBullets = Array.isArray(tpl.bullets) && tpl.bullets.length > 0 && staff.role !== 'other';
  const bulletsHtml = hasBullets ? `
    <p style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#999;text-transform:uppercase;margin:28px 0 10px;">${EVTT(loc, 'staff_briefing.resp_header')}</p>
    <ul style="margin:0 0 20px;padding:0;list-style:none;">
      ${tpl.bullets.map(b => `
        <li style="position:relative;padding:0 0 10px 24px;font-size:14px;color:#444;line-height:1.55;">
          <span style="position:absolute;left:0;top:5px;display:inline-block;width:8px;height:8px;background:#FF1B8D;border-radius:50%;"></span>
          ${b}
        </li>`).join('')}
    </ul>
  ` : '';

  const customText = (staff.custom_briefing || '').trim();
  const customHtml = customText ? `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:14px 18px;margin:0 0 24px;">
      <p style="margin:0 0 6px;font-size:13px;color:#9a3412;font-weight:700;">${EVTT(loc, 'staff_briefing.custom_header')}</p>
      <p style="margin:0;font-size:13px;color:#9a3412;line-height:1.6;white-space:pre-wrap;">${customText}</p>
    </div>
  ` : '';

  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;line-height:1.25;">
      ${EVTT(loc, 'staff_briefing.h1')}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      ${EVTT(loc, 'staff_briefing.intro', { name: staff.name, event: event.name })}
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_briefing.lbl_role')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${roleLabel}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_briefing.lbl_datetime')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${startStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_briefing.lbl_arrival')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${EVTT(loc, 'staff_briefing.arrival_prefix')} · ${arrivalStr}</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">${EVTT(loc, 'staff_briefing.lbl_venue')}</p>
        <p style="margin:0;font-size:15px;color:#0f0f0f;font-weight:600;">${venueLine}</p>
      </td></tr>
    </table>

    ${bulletsHtml}
    ${customHtml}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${panelUrl}" style="display:inline-block;padding:14px 26px;background:#0f0f0f;color:#ffffff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;letter-spacing:0.5px;">
          ${EVTT(loc, 'staff_briefing.cta')}
        </a>
      </td></tr>
    </table>

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin:0 0 8px;">
      <p style="margin:0;font-size:13px;color:#1e3a8a;line-height:1.55;">
        ${EVTT(loc, 'staff_briefing.help_note', { producer: producerName, email: producerEmail })}
      </p>
    </div>
  `, { tagline: EVTT(loc, 'tagline') });

  await transporter.sendMail({
    from: FROM,
    to: staff.email,
    subject: EVTT(loc, 'staff_briefing.subject', { event: event.name })
    ,
    html
  });
  console.log(`✅ Briefing staff enviado a ${staff.email} (${event.name}) [${loc}]`);
}

// ─────────────────────────────────────────────────────────────────────────
// Events — welcome email trial (post register con product=events) · 15-oct-2026
// ─────────────────────────────────────────────────────────────────────────
async function sendEventsWelcomeEmail(user, trialEndDate) {
  const endStr = trialEndDate
    ? new Date(trialEndDate).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' })
    : '30 días desde hoy';
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;letter-spacing:-0.3px;">
      Bienvenido a SONORO Events
    </h1>
    <p style="margin:0 0 24px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${user.name || 'de nuevo'}</strong>, tu cuenta ya está activa con el plan Trial.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin-bottom:24px;">
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Plan</p>
        <p style="margin:0;font-size:16px;color:#0f0f0f;font-weight:700;">Trial — 30 días</p>
      </td></tr>
      <tr><td style="padding:16px 24px;border-bottom:1px solid #eee;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Incluye</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;line-height:1.6;">1 evento activo · hasta 150 asistentes · check-in QR · formulario público · emails transaccionales</p>
      </td></tr>
      <tr><td style="padding:16px 24px;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#999;">Vence</p>
        <p style="margin:0;font-size:14px;color:#0f0f0f;">${endStr}</p>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${CMS_URL}/dashboard.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Crear mi primer evento
        </a>
      </td></tr>
    </table>

    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.6;">
      Al terminar el trial podés pasar a un plan pago desde el dashboard sin perder datos. Si necesitas ayuda, respondé este correo.
    </p>
  `, { tagline: 'Software de gestión de eventos' });

  await transporter.sendMail({
    from: FROM,
    to: user.email,
    subject: 'Bienvenido a SONORO Events — tu trial de 30 días ya está activo',
    html
  });
  console.log(`✅ Welcome Events enviado a ${user.email}`);
}

// ── EMAIL — CERTIFICADO EMITIDO (E4) ─────────────────────────────────────────
async function sendCertificateEmail({ to, attendeeName, eventName, certUrl, pdfPath }) {
  if (!to) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;line-height:1.25;">
      Tu certificado está listo
    </h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">
      Hola ${attendeeName || ''}, gracias por participar en <strong>${eventName}</strong>.
      Adjuntamos tu certificado en PDF.
    </p>
    <p style="margin:0;font-size:13px;color:#999;line-height:1.6;">
      La validez puede verificarse escaneando el código QR del certificado.
    </p>
  `, { tagline: 'Software de gestión de eventos' });

  const mailOpts = { from: FROM, to, subject: `Tu certificado — ${eventName}`, html };
  if (pdfPath) {
    try {
      const fsx = require('fs');
      if (fsx.existsSync(pdfPath)) {
        mailOpts.attachments = [{ filename: 'certificado.pdf', path: pdfPath, contentType: 'application/pdf' }];
      }
    } catch (_) {}
  }
  await transporter.sendMail(mailOpts);
  console.log(`✅ Certificado enviado a ${to} (${eventName})`);
}

// ── EMAIL — RUEDA DE NEGOCIOS: BIENVENIDA PRIMARIO (E-RN-1b) ─────────────────
async function sendRnWelcomeEmail({ to, delegateName, companyName, eventName, eventSlug, agendaUrl, locale }) {
  if (!to || !agendaUrl) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;letter-spacing:-0.3px;line-height:1.25;">
      ${companyName} quedó inscrita en ${eventName}
    </h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${delegateName}</strong>, confirmamos tu inscripción como delegado primario.
      Tu agenda personal queda en el enlace de abajo &mdash; guárdalo, es tu acceso durante todo el evento.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${agendaUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Abrir mi agenda
        </a>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin:0 0 20px;">
      <tr><td style="padding:14px 20px;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;word-break:break-all;">
          ${agendaUrl}
        </p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
      Como delegado primario puedes invitar a tu equipo desde la misma página, pedir reuniones con otras empresas y revisar tu agenda en tiempo real.
    </p>
  `, { tagline: 'Rueda de Negocios' });
  await transporter.sendMail({
    from: FROM, to,
    subject: `Inscripción confirmada &mdash; ${eventName}`,
    html,
  });
  console.log(`✅ RN welcome enviado a ${to} (${eventSlug})`);
}

// ── EMAIL — RUEDA DE NEGOCIOS: INVITACIÓN DELEGADO SECUNDARIO (E-RN-1b) ──────
async function sendRnDelegateInvitedEmail({ to, delegateName, inviterName, companyName, eventName, agendaUrl }) {
  if (!to || !agendaUrl) return;
  const html = baseTemplate(`
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#0f0f0f;letter-spacing:-0.3px;line-height:1.25;">
      ${inviterName} te invitó a ${eventName}
    </h1>
    <p style="margin:0 0 20px;font-size:15px;color:#666;line-height:1.6;">
      Hola <strong style="color:#0f0f0f;">${delegateName}</strong>, representas a
      <strong style="color:#0f0f0f;">${companyName}</strong> en esta rueda de negocios.
      Tu agenda es independiente: el solver te asigna reuniones propias y puedes pedir las tuyas.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td align="center">
        <a href="${agendaUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#FF1B8D,#FF8C00);color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;">
          Aceptar y abrir mi agenda
        </a>
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:8px;margin:0 0 20px;">
      <tr><td style="padding:14px 20px;">
        <p style="margin:0;font-size:12px;color:#999;line-height:1.5;word-break:break-all;">
          ${agendaUrl}
        </p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
      Al abrir el enlace completas tu perfil. Puedes editar tu nombre, teléfono y cargo en cualquier momento.
    </p>
  `, { tagline: 'Rueda de Negocios' });
  await transporter.sendMail({
    from: FROM, to,
    subject: `Fuiste invitado a ${eventName}`,
    html,
  });
  console.log(`✅ RN delegate-invited enviado a ${to}`);
}

module.exports = { sendWelcomeEmail, sendDeviceActivatedEmail, sendActivationGuideEmail, sendLicenseRenewedEmail, sendLicenseExpiringEmail, sendAgentCredentialsEmail, sendBulkPushReport, sendPasswordResetEmail, sendEventRegistrationEmail, sendEventPendingEmail, sendInvitationConfirmedEmail, sendInvitationPendingEmail, sendSupplierQuoteEmail, sendSupplierAcceptedEmail, sendSupplierDepositEmail, sendSupplierPaidEmail, sendStaffCredentialsEmail, sendStaffBriefingEmail, sendEventsWelcomeEmail, sendCertificateEmail, sendRnWelcomeEmail, sendRnDelegateInvitedEmail, verifyConnection };
