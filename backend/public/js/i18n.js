/**
 * SONORO CMS — i18n runtime (ES / EN / PT-BR)
 * Fase 2a — S190b. Standalone, no HTML changes required.
 *
 * Exposes window.SonoroI18n = { t, applyI18n, setLocale, getLocale }.
 * Persists preference in localStorage['sonoro_locale'] and syncs to backend
 * (PATCH /api/user/locale) when authToken is present.
 *
 * Patches (monkey-patch) known dashboard render functions to re-translate on
 * language change. Patches are guarded — if the target function is not present
 * in the current page, the patch is a no-op.
 */
(function(){
  'use strict';
  var LOCALES = {
    es: {
      common: { loading:'Cargando…', save:'Guardar', change:'Cambiar', refresh:'↻ Actualizar', delete:'Eliminar', edit:'Editar', cancel:'Cancelar', close:'Cerrar', copy:'Copiar', copied:'Copiado', yes:'Sí', no:'No', online:'En línea', offline:'Fuera de línea' },
      cnt: { title:'Gestor de Contenido', upload_title:'Subir Archivo', upload_btn:'↑ Subir', uploading:'Subiendo', preview:'Vista Previa', files:'Archivos', choose_file:'Seleccionar archivo', no_file:'Sin archivo', no_files:'Aún no has subido contenido.', assigned_to:'Asignado a', duration:'Duración', size:'Tamaño', type_video:'Video', type_image:'Imagen' },
      plm: { new_title:'Nueva Lista', edit_title:'Editar Lista', name:'Nombre', name_ph:'Nombre de la lista', desc:'Descripción', desc_ph:'Descripción', orientation:'Orientación de Pantalla', horizontal:'Horizontal (16:9)', vertical:'Vertical (9:16)', shuffle:'Orden Aleatorio', repeat:'Repetir Infinitamente', add_content:'Agregar Contenido', select_file:'-- Seleccionar archivo --', add:'+ Agregar', content:'Contenido', empty:'Vacío' },
      act: { title:'Códigos de Activación', gen_btn:'Generar código', code_label:'Código de activación', existing:'Códigos generados', dev_name:'Nombre del dispositivo (opcional)', dev_name_ph:'Ej: Recepción, Sala de espera...' },
      pl: { title:'Listas de Reproducción', new_btn:'+ Nueva Lista', no_playlists:'Aún no has creado listas.', items:'elementos', empty:'Lista vacía', assign:'Asignar', unassign:'Desasignar', rename:'Renombrar', duplicate:'Duplicar' },
      dev: { title:'Gestión de Dispositivos', add_device:'+ Agregar dispositivo', add_smarttv:'+ Agregar Smart TV', gen_code:'+ Generar Código', repair_smarttv:'Re-emparejar', no_devices:'Aún no tienes dispositivos activados.', last_seen:'Última conexión', temp:'Temperatura', screenshot:'Captura', logs:'Logs', reboot:'Reiniciar', ssh:'SSH', unassigned:'Sin asignar', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Espejo', mode_pro:'Independiente' },
      wiz: { s1_title:'Agregar dispositivo', s1_sub:'¿Qué tipo de dispositivo vas a conectar?', type_rpi:'SONORO Player', type_rpi_desc:'Hardware dedicado (RPi)', type_win:'SONORO Player', type_win_desc:'Windows PC', type_smarttv:'Smart TV', type_smarttv_desc:'TV con navegador', next:'Siguiente', back:'← Atrás', add:'Agregar', continue:'Continuar', s2tv_title:'Agregar Smart TV', s2tv_sub:'Sigue estos pasos en el TV y copia el código que aparece en su pantalla.', tv_inst_title:'En el TV', tv_inst_1:'Enciende el TV y abre el navegador.', tv_inst_2:'Entra a <span style="background:#111;color:#c9a4ff;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:11px;">cms.sonoro.com.co/pair</span>', tv_inst_3:'Copia abajo el código de 6 caracteres que aparece en pantalla.', code:'Código del TV', name:'Nombre del dispositivo', orientation:'Orientación', s2p_title:'Generar código de activación', s2p_sub:'El instalador te pedirá este código al configurar el dispositivo.' },
      login: { sub:'CMS · Pantallas Informativas', tab_signin:'Ingresar', tab_signup:'Registrarse',
        email:'Email', password:'Contraseña', name:'Nombre',
        signin_btn:'Ingresar', signup_btn:'Crear Cuenta',
        forgot:'Olvidé mi contraseña', forgot_send:'Enviar instrucciones',
        picker_q:'¿Qué vas a usar?', form_section:'Tu cuenta',
        signage_t:'Pantallas informativas', signage_d:'Cartelería digital en TVs y pantallas',
        events_t:'Gestión de eventos', events_d:'Registro, check-in y staff' },
      topbar: { session:'Sesión', logout:'Cerrar Sesión', theme_light:'Claro', theme_dark:'Oscuro' },
      sidebar: { group_content:'Gestión de<br>Contenido', tab_content:'Contenido', tab_playlists:'Playlist', tab_devices:'Dispositivos',
        tab_multisede:'Sedes', tab_multiplaylist:'Programaciones',
        group_licenses:'Licencias', tab_my_licenses:'Mis Licencias', tab_my_account:'Mi Cuenta', tab_account:'Cuenta', tab_queue:'Turnos', tab_events:'Eventos' },
      ms: { title:'Sedes', subtitle:'Organiza tus dispositivos por ubicación y envía contenido a varias sedes a la vez.',
        upsell_title:'Organiza tus dispositivos por sede',
        upsell_desc:'Agrupa pantallas por ubicación, envía la misma playlist a varias sedes con un clic y obtén reportes por ubicación. Ideal si operas más de una tienda o punto de venta.',
        upsell_cta:'Contactar a comercial →',
        pro_banner_title:'Plan Multi-sede activo', sedes_word:'sedes', devices_word:'dispositivos', bulk_enabled:'Bulk push habilitado',
        tab_sedes:'Sedes', tab_bulk:'Envío masivo', your_sedes:'Tus sedes',
        your_sedes_hint:'Cada dispositivo puede pertenecer a una sede. Se usa para filtrar en envío masivo y reportes por ubicación.',
        new_sede:'+ Nueva sede', modal_new_title:'Nueva sede', field_name:'Nombre', field_country:'País', field_city:'Ciudad', save:'Guardar sede' },
      mp: { title:'Programaciones', subtitle:'Programa varias listas por franja horaria en un mismo dispositivo.',
        upsell_title:'Programa varias playlists por franja horaria',
        upsell_desc:'Asigna distintas listas a la misma pantalla según hora del día — mañana promoción, tarde menú, noche marca. Ideal para restaurantes, retail y espacios con audiencias que cambian.',
        upsell_cta:'Contactar a comercial →' },
      bp: { title:'Envío masivo de playlist', subtitle:'Selecciona una playlist y las sedes destino. Todos los dispositivos filtrados reciben la misma lista.', pending:'Envío masivo — próxima entrega (Bloque B).' },
      lic: { title:'Mis Licencias', buy_btn:'+ Comprar licencia',
        kpi_active:'Activas', kpi_trial:'En prueba', kpi_expiring:'Por vencer (30d)', kpi_pending:'Órdenes pendientes',
        trial_title:'Prueba gratis 15 días', trial_sub:'Escoge Smart TV o Windows. Incluye 150 MB durante la prueba. Solo una prueba por cuenta.', trial_btn:'Activar prueba',
        trial_modal_title:'Activar prueba gratis', trial_modal_sub:'Escoge un producto. 15 días · 150 MB de almacenamiento · sin tarjeta · solo una prueba por cuenta.',
        trial_modal_note:'Solo puedes activar una prueba por cuenta y no podrás cambiar de producto luego.',
        trial_prod_smarttv:'Smart TV', trial_prod_smarttv_desc:'Reproduce en tu Smart TV con la app SONORO Player.',
        trial_prod_windows:'Windows', trial_prod_windows_desc:'Reproduce en PC Windows en modo kiosko.',
        trial_activated_toast:'Prueba de 15 días activada',
        trial_ending_title:'Tu prueba está por terminar.', trial_ending_body:'Compra una licencia para continuar sin interrupciones.',
        trial_buy_btn:'Comprar licencia', trial_grandfathered:'Prueba original de 30 días sin límite de almacenamiento.',
        storage_label:'Almacenamiento', storage_near:'Cerca del límite de la prueba.', storage_full:'Alcanzaste el límite de 150 MB de la prueba.',
        storage_toast_trial:'Alcanzaste 150 MB de la prueba. Actualiza a plan pago para 500 MB.', storage_toast_paid:'Alcanzaste tu límite de almacenamiento.',
        badge_trial:'Prueba', badge_active:'Activa', badge_expired:'Vencida',
        expires_word:'Vence', days_word:'días', device_word:'Dispositivo', no_device:'Sin dispositivo asignado', renew_btn:'Renovar',
        active_title:'Licencias activas', history_title:'Historial de órdenes',
        col_order:'Orden', col_product:'Producto', col_amount:'Monto', col_status:'Estado', col_date:'Fecha', col_action:'Acción',
        ev_title:'Events v1',
        ev_tier_trial:'Trial', ev_tier_lite:'Lite', ev_tier_pro:'Pro', ev_tier_masivo:'Masivo',
        ev_active_sub:'Plan activo · vence el',
        ev_days_left:'días restantes', ev_day_left:'día restante',
        ev_grace_title:'Pago vencido',
        ev_grace_body:'Mantienes acceso completo hasta el',
        ev_readonly_title:'Modo solo lectura',
        ev_readonly_body:'No puedes crear ni editar eventos hasta reactivar tu licencia.',
        ev_no_license_title:'Aún no tienes acceso a Events v1',
        ev_no_license_body:'Activa un plan para empezar a crear eventos.',
        ev_admin_bypass:'Acceso administrador · sin licencia requerida',
        ev_btn_pay:'Pagar ahora', ev_btn_reactivate:'Reactivar', ev_btn_plans:'Ver planes', ev_btn_manage:'Gestionar' },
      mc: { title:'Mi Cuenta', personal_info:'Información personal',
        email:'Email', name:'Nombre', role:'Rol', country:'País',
        change_pw:'Cambiar contraseña', pw_current:'Contraseña actual', pw_new:'Nueva contraseña (mín. 8)', pw_confirm:'Confirmar nueva contraseña', change_pw_btn:'Cambiar contraseña',
        role_admin:'Administrador', role_agent:'Agente', role_client:'Cliente' },
      stv: { horizontal:'Horizontal', vertical:'Vertical', err_invalid_code:'Código inválido (6 caracteres A-Z, 0-9).' },
      usd: { title:'Nueva orden — Internacional', sub:'Elige el producto y suscríbete vía PayPal.', product:'Producto', prod_smarttv:'SONORO Smart TV — suscripción mensual', prod_windows:'SONORO Windows — suscripción mensual', prod_player:'SONORO Player — suscripción mensual', amount:'Monto', pay_paypal:'Pago con PayPal', subscribe:'Suscribirse en PayPal', create_order:'Crear orden' },
      pro: { badge:'Plan Pro activo', desc:'— envía la misma playlist a múltiples pantallas y agrúpalas por sede.', tags:'Bulk Push · Multi-sede · Reportes por ubicación', cta:'Ir a Sedes & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Cerrar Sesión' },
      sb: { mi_cuenta:'Mi Cuenta', resumen:'Resumen', mis_dispositivos:'Mis Dispositivos', mis_sedes:'Mis Sedes', ver_sedes:'Ver Sedes', contenido:'Contenido', bulkpush:'Bulk Push' },
      ov: { title:'Resumen', refresh:'Actualizar', server:'Servidor CMS', operative:'Operativo', devices:'Dispositivos', sedes:'Sedes', playlists:'Playlists activas', playing_now:'en reproducción ahora', content:'Contenido', files:'archivos', status_by_sede:'Estado por sede', loading_sedes:'Cargando sedes...' },
      md: { title:'Mis Dispositivos', sub:'Dispositivos asignados a tu cuenta' },
      bp: { title:'Bulk Push', sub:'Envío masivo de playlist a múltiples dispositivos',
        step_playlist:'Playlist', step_dest:'Destino', step_format:'Formato', step_confirm:'Confirmar',
        s1_label:'1 — Playlist a enviar', select_playlist:'— Seleccionar playlist —',
        s2_label:'2 — Nivel geográfico de destino', country:'País', city:'Ciudad', branch:'Sede', all_f:'Todas', route:'Ruta:',
        s3_label:'3 — Formato de pantalla', all_sub:'Sin filtrar por orientación', horizontal:'Horizontal', horizontal_sub:'Pantallas apaisadas', vertical:'Vertical', vertical_sub:'Pantallas de pie',
        s4_label:'4 — Previsualizar y confirmar', preview:'Previsualizar', recv_title:'Dispositivos que recibirán la playlist', devices:'dispositivos',
        th_device:'Dispositivo', th_city_branch:'Ciudad / Sede', th_ports:'Puertos', th_current:'Playlist actual', th_action:'Acción', send_all:'Enviar a todos' },
      ev: { tab:'Mis Eventos', title_my:'Mis Eventos', new_btn:'+ Nuevo Evento', title_new:'Nuevo Evento', back:'Volver', back_list:'Mis Eventos', cancel:'Cancelar', create:'Crear Evento', delete_event:'Eliminar evento', filter_all:'Todos', filter_matchmaking:'Ruedas', new_type_label:'Tipo', new_type_std:'Evento estándar', new_type_rn:'Rueda de Negocios', new_rn_mode:'Modo de matching', new_rn_mode_auto:'Automático por intereses (tags)', new_rn_mode_manual:'Solo manual', new_rn_zone:'Zona', new_rn_zone_classic:'Clásica (una sola zona)', new_rn_zone_zoned:'Zonificada',
            sub_info:'Información', sub_form:'Formulario', sub_regs:'Registros', sub_staff:'Staff', sub_suppliers:'Proveedores', sub_rundown:'Producción', sub_certs:'Certificados',
            f_name:'Nombre del evento *', f_start:'Fecha inicio *', f_end:'Fecha fin *', f_tz:'Zona horaria', f_capacity:'Capacidad máxima', f_desc:'Descripción', f_venue:'Venue / Lugar',
            card_data:'Datos del evento', c_name:'Nombre', c_desc:'Descripción', c_venue:'Venue', c_capacity:'Capacidad', c_start:'Fecha inicio', c_end:'Fecha fin', c_tz:'Zona horaria',
            publish_cal:'Publicar en mi calendario externo',
            no_events:'Aún no has creado eventos.',
            save:'Guardar cambios',
            // Nuevo evento — placeholders
            f_name_ph:'Ej: Convención SONORO 2026', f_capacity_ph:'Ej: 500', f_desc_ph:'Descripción pública del evento…', f_venue_ph:'Ej: Hotel Tequendama, Bogotá',
            // Información — tipos de entrada
            inf_ticket_types:'Tipos de entrada', inf_ticket_types_hint:'uno por línea · vacío = solo "general"', inf_ticket_types_ph:'Escribe un tipo por línea, ej:\nGeneral\nVIP\nSpeaker',
            // Sesiones
            sess_card:'Sesiones / Jornadas', sess_add:'+ Agregar', sess_regmode_label:'Tipo de inscripción:',
            sess_regmode_full:'Inscripción general (todas las sesiones)', sess_regmode_per:'Multisesiones (inscripción a sesiones específicas)',
            sess_regmode_help:'Las sesiones privadas o solo-invitación nunca aparecen en el formulario público.',
            sess_f_name:'Nombre de la sesión', sess_f_name_ph:'Ej: Día 1 — Mañana',
            sess_f_speaker:'Orador / Speaker', sess_f_speaker_ph:'Nombre del orador (opcional)',
            sess_f_date:'Fecha', sess_f_cap:'Cupo (opc.)', sess_f_cap_ph:'Sin límite',
            sess_f_start:'Hora inicio', sess_f_end:'Hora fin',
            sess_f_staff:'Responsable', sess_staff_none:'— Sin asignar —',
            sess_f_obs:'Observaciones', sess_f_obs_ph:'Notas o indicaciones especiales…',
            sess_f_visibility:'Visibilidad',
            sess_vis_public:'Pública — todos pueden verla e inscribirse',
            sess_vis_private:'Privada — solo el productor la asigna manualmente',
            sess_vis_invite:'Solo invitados — requiere link de invitación',
            sess_save:'Guardar sesión',
            // Mails
            mail_card:'Configuración de correos',
            mail_from:'Nombre del remitente', mail_from_hint:'(aparece en el inbox del destinatario)', mail_from_ph:'SONORO CMS (por defecto)',
            mail_reply:'Reply-To', mail_reply_hint:'(a quién responde el destinatario)', mail_reply_ph:'Vacío = sin reply-to',
            mail_note:'Los correos siempre se envían desde <strong>cms@sonoro.com.co</strong>. El nombre del remitente y el Reply-To son visibles para el destinatario. Aplica a confirmaciones de registro y correos de cotización a proveedores.',
            // Formulario — modo confirmación
            fm_confirm_mode:'Modo de confirmación',
            fm_conf_auto:'Confirmación automática', fm_conf_auto_d:'Al inscribirse llega el pase con código QR de forma inmediata',
            fm_conf_manual:'Confirmación manual', fm_conf_manual_d:'El inscrito recibe aviso de que será confirmado por el equipo del evento. Al confirmar desde el dashboard se envía el pase con QR',
            // Formulario — campos fijos
            fx_title:'Campos fijos — siempre presentes',
            fx_fullname:'Nombre completo', fx_email:'Correo electrónico', fx_phone:'Teléfono (+prefijo)', fx_doc:'Tipo + N° documento', fx_ticket:'Tipo de entrada',
            // Formulario — activos / catálogo
            fm_active:'Campos en el formulario',
            fcat_title:'Campos disponibles para añadir',
            fm_new_custom:'Crear campo personalizado', fm_type_label:'Tipo:',
            fm_type_text:'Texto', fm_type_select:'Selección', fm_type_bool:'Sí / No', fm_type_tel:'Teléfono',
            fm_save:'Guardar formulario', fm_preview:'Vista previa',
            // Modal nuevo campo
            fmod_title:'Nuevo campo',
            fmod_label_es:'Etiqueta ES', fmod_label_es_ph:'Ej: Empresa',
            fmod_label_en:'Label EN', fmod_label_en_ph:'e.g. Company',
            fmod_required:'Campo obligatorio',
            fmod_opts:'Opciones', fmod_opt_ph:'Nueva opción…', fmod_opt_add:'+ Añadir',
            fmod_cond:'Mostrar solo si… (opcional)',
            fmod_cond_always:'— Siempre visible —', fmod_cond_ticket:'Tipo de entrada =',
            fmod_cond_val_ph:'ej: vip',
            fmod_add:'Añadir al formulario',
            // Registros
            reg_links:'Enlaces del evento',
            reg_link_public:'Registro público', reg_link_app:'App Check-in', reg_link_kiosko:'Kiosko check-in',
            reg_open:'Abrir',
            reg_search_ph:'Buscar por nombre o email…',
            reg_import:'Importar CSV/XLSX', reg_template:'Plantilla', reg_template_title:'Plantilla XLSX con las columnas del formulario de este evento + instrucciones',
            reg_export_csv:'Exportar CSV', reg_export_pdf:'Exportar PDF',
            reg_print_all:'Imprimir todos', reg_print_all_title:'Imprimir etiquetas QR de todos los registros',
            reg_th_name:'Nombre', reg_th_email:'Email', reg_th_type:'Tipo', reg_th_status:'Estado', reg_th_date:'Registro',
            // Staff
            stf_card:'Equipo del evento', stf_add:'+ Agregar',
            stf_new_title:'Nuevo miembro de staff',
            stf_name:'Nombre *', stf_name_ph:'Ej: Juan Pérez',
            stf_role:'Rol *', stf_role_select:'— Seleccionar —',
            stf_role_coord:'Coordinador', stf_role_reg:'Coordinador de Registro', stf_role_tech:'Coordinador Técnico',
            stf_role_host:'Coordinador de Anfitriones', stf_role_sec:'Coordinador de Seguridad',
            stf_role_cat:'Coordinador de Catering', stf_role_art:'Coordinador Artístico y de Entretenimiento',
            stf_role_other:'Otro',
            stf_email:'Email', stf_email_ph:'opcional',
            stf_phone:'Teléfono', stf_phone_ph:'opcional',
            stf_pin:'PIN de acceso (check-in)', stf_pin_gen:'Generar', stf_pin_ph:'6 dígitos — se genera automáticamente',
            stf_locale:'Idioma del staff (emails)',
            stf_locale_es:'Español', stf_locale_en:'English', stf_locale_pt:'Português (BR)',
            stf_custom:'Mensaje personal (opcional)', stf_custom_ph:'Ej: María, llega a las 5:45 PM para coordinar las acreditaciones VIP…',
            stf_custom_hint:'Este texto se añade al email de briefing como "Mensaje del productor".',
            stf_save:'Guardar',
            stf_pool_title:'Catálogo de staff', stf_pool_hint:'Reciclable entre eventos. Agrega aquí para no volver a escribir los datos.',
            stf_pool_search_ph:'Buscar…', stf_pool_manage:'Gestionar catálogo →',
            // Suppliers / proveedores
            sup_budget_card:'Presupuesto del evento', sup_csv_title:'Descargar CSV', sup_pdf_title:'Descargar PDF', sup_budget_edit:'Editar presupuesto',
            sup_budget_ph:'Presupuesto total (COP)', sup_save:'Guardar',
            sup_card_budget:'Presupuesto', sup_card_cot:'Total cotizado', sup_card_appr:'Total aprobado', sup_card_paid:'Total pagado', sup_card_bal:'Saldo disponible',
            sup_card_title_budget:'Presupuesto máximo asignado al evento',
            sup_card_title_cot:'Suma de cotizaciones recibidas o aceptadas',
            sup_card_title_appr:'Suma de contratos aceptados (comprometido)',
            sup_card_title_paid:'Dinero que ya salió: abonos + pagados',
            sup_card_title_bal:'Presupuesto menos total aprobado (puede ser negativo)',
            sup_contracts:'Proveedores', sup_contract_add:'+ Agregar',
            sup_c_supplier:'Proveedor del directorio *', sup_c_supplier_sel:'— Selecciona proveedor —',
            sup_c_role:'Descripción del servicio', sup_c_role_ph:'Ej: Sonido principal, Cobertura fotográfica',
            sup_c_amount:'Presupuesto aproximado (COP)',
            sup_c_notes:'Notas', sup_c_notes_ph:'Observaciones',
            sup_dir:'Directorio de proveedores', sup_dir_new:'+ Nuevo',
            sup_d_name:'Nombre *', sup_d_name_ph:'Nombre empresa o persona',
            sup_d_cat:'Categoría', sup_d_cat_ph:'Ej: Sonido, Fotografía, Catering',
            sup_d_contact:'Contacto', sup_d_contact_ph:'Nombre contacto',
            sup_d_phone:'Teléfono', sup_d_phone_ph:'+57 300 0000000',
            sup_d_email:'Email', sup_d_email_ph:'proveedor@ejemplo.com',
            sup_d_id_type:'Tipo ID', sup_d_id_num:'N° identificación', sup_d_id_num_ph:'900.123.456-7',
            sup_d_locale:'Idioma del proveedor (emails)',
            sup_d_docs:'Documentos legales', sup_d_doc_rut:'RUT', sup_d_doc_cert:'Cert. bancario', sup_d_doc_camara:'Cámara comercio',
            // Producción
            prod_dash_title:'Dashboard de producción', prod_dash_tag:'Productor',
            prod_dash_desc:'Monitor de control en vivo: stats, cronómetro, sesiones y canal a pantallas. Pantalla principal del productor general.',
            prod_open_newtab:'Abrir en nueva pestaña', prod_copy_url:'Copiar URL', prod_revoke:'Revocar token', prod_gen_url:'Generar URL pública',
            prod_tp_title:'Teleprompter', prod_tp_tag:'Orador',
            prod_tp_desc:'Vista limpia para monitor de confidence del orador: nombre de sesión, timer gigante, qué sigue. URL distinta por sesión.',
            prod_tp_session:'Sesión:', prod_tp_nosess:'Sin sesiones',
            prod_tp_open:'Abrir', prod_tp_copy:'Copiar', prod_tp_wa:'WhatsApp', prod_tp_revoke:'Revocar',
            prod_tp_gen:'Generar URL para esta sesión',
            prod_libreto:'Libreto del evento', prod_cue_add:'+ Agregar cue',
            prod_cue_num:'Nro', prod_cue_num_ph:'01',
            prod_cue_title_lbl:'Título *', prod_cue_title_ph:'Apertura del evento',
            prod_cue_sched:'Hora programada *',
            prod_cue_dur:'Duración (min)', prod_cue_dur_ph:'30',
            prod_cue_zone:'Zona / Espacio', prod_cue_zone_ph:'Auditorio principal',
            prod_cue_resp:'Responsable',
            prod_cue_notes:'Notas técnicas', prod_cue_notes_ph:'Audio: mic inalámbrico. Video: slide 1…',
            prod_th_num:'Nro', prod_th_time:'Hora', prod_th_title:'Título', prod_th_dur:'Dur.', prod_th_zone:'Zona', prod_th_status:'Estado',
            // Certificados
            cert_intro_title:'Certificados del evento',
            cert_intro_desc:'Diseña tu certificado como una imagen de fondo (canvas). El sistema solo superpone los datos dinámicos: nombre, evento, sesión, horas, fecha y QR de verificación.',
            cert_guide:'Abrir guía de diseño',
            cert_tpls:'Plantillas', cert_tpl_new:'Nueva plantilla',
            cert_issued:'Emitidos', cert_search_ph:'Buscar…', cert_bulk:'Emisión masiva',
            cert_th_att:'Asistente', cert_th_tpl:'Plantilla', cert_th_hours:'Horas', cert_th_issued:'Emitido', cert_th_status:'Estado',
            // Pase 2 — strings dinámicos
            manage:'Gestionar', publish:'Publicar', unpublish:'Despublicar',
            unpublish_confirm:'¿Despublicar el evento? La página pública dejará de ser accesible.',
            list_loading:'Cargando eventos…', list_empty_title:'Sin eventos todavía', list_empty_sub:'Crea tu primer evento para comenzar.', list_error:'Error cargando eventos.',
            panel: { title:'Panel resumen', sub_default:'Vista agregada de tus eventos · últimos 12 meses', sub_30d:'Vista agregada · últimos 30 días', sub_90d:'Vista agregada · últimos 90 días', sub_12m:'Vista agregada · últimos 12 meses', sub_ytd:'Vista agregada · lo que va del año', sub_all:'Vista agregada · histórico completo', r_ytd:'YTD', r_all:'Todo', collapse:'Colapsar / expandir', k_events:'Eventos realizados', k_done:'Realizados', k_sched:'Programados', k_cancel:'Cancelados', k_done_sub:'de 0 totales', k_done_sub_tpl:'de {total} totales', k_att:'Asistentes', k_att_sub:'asistieron (de 0)', k_att_sub_tpl:'asistieron (de {reg})', k_checkin:'Check-in', k_noshow:'No show', k_proj:'Presupuesto proyectado', k_total:'Total', k_avg:'Promedio evento', k_paid:'Presupuesto pagado', k_paid_sub:'pagado a proveedores', k_paid_lbl:'Pagado', k_pending:'Pendiente', events_word:'eventos', top5_title:'Top eventos por asistencia', top5_empty:'Sin eventos realizados en el rango.', monthly_title:'Eventos por mes', day:'día', days:'días', attendees_short:'asist', tier_badge:'Pro · Masivo', teaser_title:'Panel de resumen', teaser_body:'Visualiza métricas agregadas de todos tus eventos: asistentes, presupuesto proyectado vs ejecutado, top eventos y evolución mensual. Exporta informes PDF y Excel.', teaser_cta:'Ver planes', export_err:'No fue posible generar el reporte.' },
            sess_edit:'Editar', sess_loading:'Cargando…', sess_empty:'Sin sesiones. Agrega una arriba.', sess_error:'Error cargando sesiones.',
            sess_cap_word:'cupos', sess_vis_private_badge:'PRIVADA', sess_vis_invite_badge:'SOLO INVITADOS',
            fm_empty:'Ningún campo añadido todavía.', fcat_all_added:'Todos los campos disponibles ya están en el formulario.',
            fcat_add:'+ Añadir al formulario', fcat_cond:'COND.', fcat_remove:'Quitar', fcat_required:'obligatorio', fcat_only_if:'solo si',
            fcat_organization:'Empresa / Institución', fcat_job_title:'Cargo', fcat_dietary:'Restricción alimentaria', fcat_tshirt_size:'Talla camiseta',
            fcat_emergency:'Contacto de emergencia', fcat_emergency_ph:'Tel. emergencia', fcat_eps:'EPS', fcat_blood_type:'Tipo de sangre',
            fcat_transport:'¿Desea ofertas de transporte y alojamiento?', fcat_tourism:'¿Desea información turística y planes complementarios?',
            fcat_attended:'¿Ha asistido a eventos anteriores?',
            reg_cancel:'Cancelar', reg_confirm:'Confirmar', reg_edit:'Editar',
            reg_assign_session:'Asignar sesión', reg_cert:'Certificado', reg_delete:'Eliminar',
            reg_status_confirmed:'Confirmado', reg_status_cancelled:'Cancelado', reg_status_pending:'Pendiente',
            reg_no_results:'Sin registros.', reg_error:'Error cargando registros.',
            reg_extra_tel:'Tel:', reg_extra_id:'ID:', reg_extra_company:'Empresa:', reg_extra_role:'Cargo:',
            reg_no_extra:'Sin datos adicionales', reg_sessions_label:'Sesiones:', reg_checkins:'Check-ins',
            reg_checkin_general:'Entrada general', reg_checkin_session:'Sesión', reg_no_checkins:'Sin check-ins registrados',
            reg_certs:'Certificados', reg_edit_title:'Editar datos del inscrito', reg_print_title:'Imprimir etiqueta QR',
            reg_assign_title:'Asignar o quitar sesiones (incluye privadas)', reg_cert_title:'Emitir / gestionar certificado',
            regs_stat_of:'de', regs_stat_seats_word:'cupos', regs_stat_no_limit:'sin límite de cupos',
            regs_stat_registered:'Inscritos', regs_stat_confirmed:'Confirmados', regs_stat_of_registered:'inscritos',
            regs_stat_pending:'Pendientes', regs_stat_pending_sub:'pendientes de confirmar',
            regs_chart_title:'Check-ins por sesión',
            stf_add_to_event:'+ Agregar al evento',
            stf_pool_empty:'Catálogo vacío. Crea staff reciclable en la pestaña Staff del sidebar.',
            stf_pool_no_results:'Sin resultados.', stf_pool_loading:'Cargando…', stf_pool_error:'Error cargando catálogo.',
            stf_send_briefing:'Enviar briefing', stf_briefing_sent:'Briefing enviado el',
            stf_briefing_title:'Enviar briefing por email', stf_pin_title:'PIN de check-in',
            sup_budget_undefined:'No definido', sup_edit:'Editar',
            sup_contracts_empty:'Sin proveedores aún.',
            sup_dir_empty:'Directorio vacío. Agrega proveedores frecuentes para reutilizarlos en futuros eventos.',
            sup_deposit:'Abono:', sup_deposit_of:'de', sup_view_quote:'Ver cotización', sup_waiting_resp:'Esperando resp.',
            sup_request_quote:'Solicitar cotización', sup_see_proof:'Ver comprobante', sup_upload_proof:'Subir comprobante',
            sup_abono_q:'¿Cuánto fue el abono?', sup_abono_ph:'Monto abonado (COP)', sup_abono_confirm:'Confirmar', sup_cancel:'Cancelar',
            sup_hist_accepted:'Aceptada', sup_hist_partial:'Abono', sup_hist_paid:'Pago completo', sup_hist_rejected:'Rechazada', sup_hist_cancelled:'Cancelada',
            cert_edit:'Editar', cert_preview:'Vista previa', cert_delete:'Eliminar', cert_resend:'Reenviar', cert_revoke:'Revocar',
            cert_tpl_empty:'Aún no hay plantillas. Crea una para empezar a emitir certificados.',
            cert_issued_empty:'Aún no hay certificados emitidos.',
            cert_reg_empty:'Este asistente aún no tiene certificados emitidos.',
            cert_tpl_scope_session:'Sesión específica', cert_tpl_scope_event:'Evento completo',
            cert_tpl_page_half:'Media carta', cert_tpl_page_letter:'Carta',
            cert_tpl_active:'Activa', cert_tpl_inactive:'Inactiva',
            cert_tpl_canvas_ok:'Canvas cargado', cert_tpl_canvas_missing:'Sin canvas',
            cert_tpl_issued_count:'emitidos', cert_tpl_edit:'Editar plantilla', cert_tpl_new:'Nueva plantilla',
            cert_state_revoked:'Revocado', cert_state_sent:'Enviado', cert_state_issued:'Emitido',
            prod_cue_empty:'Sin cues. Agrega el primero con el botón de arriba.',
            prod_status_pending:'Pendiente', prod_status_in_progress:'En curso', prod_status_done:'Finalizado',
            prod_status_skipped:'Omitido', prod_status_delayed:'Con retraso', prod_cue_edit:'Editar',
            toast_ev_created:'Evento creado', toast_ev_updated:'Evento actualizado', toast_ev_deleted:'Evento eliminado',
            toast_ev_published:'Evento publicado — la página pública ya está activa', toast_ev_unpublished:'Evento despublicado',
            toast_sess_added:'Sesión agregada', toast_sess_updated:'Sesión actualizada', toast_sess_deleted:'Sesión eliminada', toast_sess_updated_bulk:'Sesiones actualizadas',
            toast_form_saved:'Formulario guardado',
            toast_staff_added:'Staff agregado', toast_staff_created:'Staff creado', toast_staff_updated:'Staff actualizado', toast_staff_deleted:'Staff eliminado',
            toast_briefing_sent:'Briefing enviado a {name}',
            toast_sup_added:'Proveedor agregado', toast_sup_created:'Proveedor creado', toast_sup_updated:'Proveedor actualizado', toast_sup_saved_dir:'Proveedor guardado en directorio',
            toast_sup_removed_ev:'Proveedor quitado del evento', toast_sup_removed_dir:'Proveedor eliminado del directorio',
            toast_budget_saved:'Presupuesto guardado', toast_price_updated:'Precio actualizado',
            toast_quote_sent:'Cotización enviada a {email}',
            toast_doc_saved:'Documento guardado', toast_receipt_saved:'Comprobante guardado',
            toast_cue_added:'Cue agregado', toast_cue_updated:'Cue actualizado', toast_cue_deleted:'Cue eliminado',
            toast_cert_tpl_created:'Plantilla creada', toast_cert_tpl_updated:'Plantilla actualizada', toast_cert_tpl_deleted:'Plantilla eliminada', toast_cert_revoked:'Certificado revocado',
            toast_mail_resent:'Correo reenviado', toast_qr_resent:'QR reenviado a {email}',
            toast_reg_updated:'Inscrito actualizado', toast_reg_deleted:'Registro eliminado',
            toast_url_generated:'URL pública generada', toast_url_copied:'URL copiada', toast_link_copied:'Enlace copiado', toast_staff_link_copied:'Link copiado — válido 24h. Envíaselo al staff.',
            toast_cal_disconnected:'Calendario desconectado',
            confirm_ev_del:'¿Eliminar "{name}"?\n\nEsta acción es irreversible: se borrarán todos los registros, check-ins y datos del evento.',
            confirm_sess_del:'¿Eliminar esta sesión?',
            confirm_reg_del:'¿Eliminar permanentemente este registro? Esta acción no se puede deshacer.',
            confirm_qr_resend:'¿Reenviar correo con el QR al inscrito?',
            confirm_staff_remove:'¿Eliminar a "{name}" del staff?',
            confirm_staff_pool_remove:'¿Quitar a "{name}" de este evento?',
            confirm_staff_cat_del:'¿Eliminar a "{name}" del catálogo? Las asignaciones a eventos pasados se conservan.',
            confirm_sup_del_dir:'¿Eliminar a "{name}" del directorio? Esta acción no se puede deshacer.',
            confirm_sup_dir_del:'¿Eliminar "{name}" del directorio?',
            confirm_cal_disc:'¿Desconectar este calendario?',
            confirm_cert_tpl_del:'¿Eliminar esta plantilla? Si ya tiene certificados emitidos, se marcará como inactiva.',
            confirm_token_revoke:'¿Revocar este token? La URL actual dejará de funcionar.',
            confirm_quote_send:'¿Enviar formato de cotización a {email}?',
            confirm_price_update:'¿Actualizar el monto contratado a {amount}?',
            confirm_cue_del:'¿Eliminar este cue?',
            confirm_contract_accepted:'¿Aceptar esta cotización? Se registrará como aprobada en el historial.',
            confirm_contract_rejected:'¿Marcar como rechazada? El proveedor quedará fuera del presupuesto.',
            confirm_contract_paid:'¿Confirmar pago completo? Se registrará en el historial.',
            confirm_contract_cancelled:'¿Cancelar este contrato? La acción quedará registrada.',
            err_generic:'Error', err_network:'Error de conexión', err_save:'Error al guardar', err_delete:'Error al eliminar', err_load:'Error al cargar', err_send:'Error al enviar', err_add:'Error al agregar',
            err_name_required:'Nombre requerido', err_role_required:'Selecciona un rol', err_role_before_send:'Selecciona un rol antes de enviar', err_session_required:'Selecciona la sesión', err_tpl_required:'Selecciona una plantilla', err_valid_amount:'Ingresa un monto válido', err_valid_value:'Ingresa un valor válido', err_open_event_first:'Abre un evento primero', err_name_dates_required:'Nombre, fecha y horas son obligatorios', err_name_dates_short:'Nombre y fechas son obligatorios', err_title_time_required:'Título y hora son requeridos',
            err_create_event:'Error creando evento', err_load_event:'Error cargando evento', err_load_staff:'Error cargando staff', err_load_sup:'Error cargando proveedores', err_load_invitations:'Error cargando invitaciones', err_load_quote:'Error cargando cotización',
            err_generate_link:'Error al generar enlace', err_generate_token:'Error generando token', err_generate_preview:'Error generando vista previa', err_generate_pdf:'Error generando PDF', err_generate_csv:'Error al generar CSV', err_generate_tpl:'Error generando plantilla', err_dl_tpl:'Error descargando plantilla', err_export_csv:'Error exportando CSV', err_import:'Error importando archivo',
            err_disconnect:'Error desconectando', err_revoke:'Error al revocar', err_resend:'Error al reenviar', err_popup_blocked:'Permite ventanas emergentes para imprimir', err_print_prep:'Error al preparar impresión',
            err_send_quote:'Error al enviar cotización', err_update_price:'Error al actualizar precio', err_update_status:'Error al actualizar estado', err_del_event:'Error al eliminar el evento', err_upload_doc:'Error al subir documento', err_upload_receipt:'Error al subir comprobante', err_save_budget:'Error al guardar presupuesto', err_save_cue:'Error al guardar cue', err_del_cue:'Error al eliminar cue',
            err_briefing:'Error al enviar briefing', err_staff_notfound:'Staff no encontrado', err_staff_noemail:'Este staff no tiene email', err_add_sup_dir_first:'Agrega proveedores al directorio primero', err_select_sup:'Selecciona un proveedor del directorio', err_no_quote:'Sin cotización', err_first_create_tpl:'Primero crea una plantilla', err_save_resend:'Guardado, pero error al reenviar: {msg}' },
      toast: { language_updated:'Idioma actualizado' },
      rn: {
        hdr: { panel:'Panel del productor', link:'Link', link_title:'Copiar link público', back:'Mis Eventos', status_published:'Publicada', status_draft:'Borrador', status_live:'En curso', status_closed:'Cerrada', status_archived:'Archivada', sub_mode:'modo', sub_zone:'zona' },
        donut: { complete_k:'Listas para emparejar', complete:'Completas', incomplete:'Incompletas', mix_k:'Mix de empresas', offer:'Ofrece', demand:'Busca', both:'Ambos', util_k:'Utilización de slots', booked:'Agendados', free:'Libres' },
        kpi: { regs:'Empresas inscritas', complete:'Con intereses completos', requests:'Solicitudes directas', util:'Utilización prevista' },
        subtab: { setup:'Setup', tags:'Tags', dir:'Directorio', agenda:'Agenda', live:'Live', rep:'Reporte' },
        toast: { saving:'Guardando…', saved_prefix:'Guardado · ', save_err:'Error al guardar', net_err:'Error de conexión', send_ok:'Reporte enviado', send_err:'Error enviando reporte', send_err_cover:'Cobertura EBV < 20%. Confirma para enviar igual.' },
        empty: { rounds_planned:'Sin rondas planificadas', tables:'Sin mesas configuradas', registered:'Sin inscritos', rounds_see_agenda:'Sin rondas planificadas (ver Agenda)', meetings_open_round:'Sin meetings — abre una ronda', tags_empty:'Sin tags · importa Excel o crea el primero', catalog_err_prefix:'Error cargando catálogo', rows:'Sin filas', meetings_ebv:'Sin meetings con EBV capturado', loading:'Cargando…', report_err:'No se pudo cargar el reporte' },
        setup: {
          c1_title:'01 · Información básica', c1_name:'Nombre', c1_public_url:'URL pública:', c1_starts:'Inicio', c1_ends:'Fin', c1_tz:'Timezone', c1_currency:'Moneda base (EBV)', c1_deflocale:'Idioma por defecto', c1_deflocale_hint:'Idioma de emails cuando el delegado no eligió uno.', c1_venue:'Sede', c1_venue_ph:'Hotel, centro de convenciones…',
          c2_title:'02 · Modo de operación', c2_classic:'Classic', c2_classic_hint:'Un único piso de mesas', c2_zoned:'Zoned', c2_zoned_hint:'Mesas agrupadas en zonas',
          c3_title:'03 · Matching', c3_tags:'Por intereses (tags)', c3_tags_hint:'Solver propone citas por overlap de intereses', c3_manual:'Solo manual', c3_manual_hint:'Todas las citas las eligen los asistentes', c3_dirview:'Vista por defecto del directorio', c3_dirview_match:'Solo con match', c3_dirview_all:'Todos los asistentes',
          c4_title:'04 · Visibilidad', c4_public:'Pública', c4_public_hint:'Registro abierto', c4_mixed:'Mixta', c4_mixed_hint:'Pública + invitaciones', c4_private:'Privada', c4_private_hint:'Solo invitados',
          c5_title:'05 · Horarios', c5_dur:'Duración por cita', c5_noshow:'No-show policy', c5_noshow_none:'Sin bloqueo', c5_buffer:'Buffer entre rondas', c5_buffer_none:'Sin buffer', c5_autoadv:'Pasar automáticamente de ronda',
          c6_title:'06 · Opciones', c6_langs:'Idiomas aceptados', c6_twodel:'Permitir dos asistentes por empresa', c6_ebv:'Capturar valor estimado de negocio (EBV)', c6_team:'Permitir invitar equipo',
          discard:'Descartar cambios', save:'Guardar configuración'
        },
        tags: {
          catalog:'Mi catálogo', count_suffix:'tags · se reutiliza entre todas tus ruedas',
          btn_template:'Plantilla', btn_export:'Exportar', btn_import:'Importar Excel', btn_new:'+ Nuevo tag',
          info_title:'¿Qué es el catálogo de tags?',
          info_p1:'Los tags son las categorías de oferta (lo que una empresa vende) y demanda (lo que busca comprar) que el asistente marca al inscribirse. El motor de la Rueda sólo empareja empresas usando los tags de este catálogo — por eso debe estar listo antes de abrir inscripciones.',
          info_p2:'¿Primera rueda? Descarga una plantilla de Excel con 2 columnas (Nombre, Categoría), llénala con los tags de tu sector y súbela aquí.',
          col_name:'Nombre', col_id:'Identificador', col_id_title:'Versión normalizada del nombre, generada automáticamente', col_cat:'Categoría', col_actions:'Acciones', loading:'Cargando…',
          new_title:'Nuevo tag', new_name:'Nombre', new_name_ph:'Ej. Software hecho a medida', new_name_hint:'Es lo que verá el asistente al elegir sus tags. Usa 1 a 5 palabras.',
          new_fuzzy_title:'¿Quisiste decir alguno de estos?', new_fuzzy_hint:'Si ninguno aplica, continúa con tu tag. Evitar duplicados mejora el emparejamiento.',
          new_cat:'Categoría (opcional)', new_cat_ph:'Ej. Tecnología', new_cat_hint:'Agrupa tags relacionados en el formulario del asistente (ej. Logística, Tecnología, Agro).',
          new_create:'Crear tag',
          edit_title:'Editar tag', save_changes:'Guardar cambios',
          bulk_title:'Previsualización · importar catálogo', bulk_det:'Detectados', bulk_new:'Nuevos', bulk_sim:'Similares', bulk_dup:'Duplicados',
          bulk_hint:'Revisa cada fila y decide. Nada se guarda hasta confirmar.', bulk_confirm:'Confirmar',
          bulk_confirm_fmt_one:'Confirmar y crear 1 tag', bulk_confirm_fmt_many:'Confirmar y crear {n} tags'
        },
        dir: { title:'Asistentes inscritos', search_ph:'Buscar empresa, nombre, tag…', col_company:'Empresa', col_contact:'Contacto', col_offer:'Ofrece', col_demand:'Busca', col_req:'Req. in/out', col_status:'Status' },
        agenda: {
          plan_title:'Planificar rondas', plan_starts:'Inicio', plan_total:'Rondas', plan_breakev:'Break c/N', plan_gen:'Generar',
          tables_title:'Mesas', tables_add:'+ Agregar',
          solver_title:'Solver', solver_preview:'Preview', solver_run:'Run solver', solver_reset:'Reset',
          meetings_title:'Meetings', meetings_refresh:'Refrescar', col_round:'Ronda', col_table:'Mesa', col_a:'Empresa A', col_b:'Empresa B', col_origin:'Origen', col_lock:'Lock'
        },
        live: {
          callboard:'Callboard productor', checkins_suffix:'check-ins', active:'Ronda activa', active_prefix:'Ronda activa: ', no_active:'Sin ronda abierta',
          rounds:'Rondas programadas', meetings:'Meetings en vivo',
          col_table:'Mesa', col_a:'Empresa A', col_b:'Empresa B', col_origin:'Origen', col_status:'Status',
          empty:'Sin meetings — abre una ronda'
        },
        rep: {
          title:'Reporte post-evento', send:'Enviar reporte por email',
          banner_ref:'Dato referencial · cobertura EBV < 20%. Interpreta con cautela.',
          banner_fx:'Varias monedas detectadas · v1 asume COP, totales son aproximados.',
          kpi_total:'Meetings totales', kpi_ebv:'Con EBV', kpi_avg:'EBV promedio / meeting', kpi_sum:'EBV total estimado',
          dist:'Distribución EBV', median:'Mediana', min:'Mínimo', max:'Máximo', bilat:'Bilateral', unilat:'Unilateral', empty:'Sin EBV',
          top:'Top meetings por valor esperado',
          col_n:'#', col_a:'Empresa A', col_b:'Empresa B', col_round_table:'Ronda · Mesa', col_type:'Tipo', col_horizon:'Horizonte', col_value:'Valor',
          empty_table:'Sin datos — carga el reporte',
          cov_suffix:'% cobertura', sending:'Enviando…'
        }
      }
    },
    en: {
      common: { loading:'Loading…', save:'Save', change:'Change', refresh:'↻ Refresh', delete:'Delete', edit:'Edit', cancel:'Cancel', close:'Close', copy:'Copy', copied:'Copied', yes:'Yes', no:'No', online:'Online', offline:'Offline' },
      cnt: { title:'Content Manager', upload_title:'Upload File', upload_btn:'↑ Upload', uploading:'Uploading', preview:'Preview', files:'Files', choose_file:'Choose file', no_file:'No file', no_files:'No content uploaded yet.', assigned_to:'Assigned to', duration:'Duration', size:'Size', type_video:'Video', type_image:'Image' },
      plm: { new_title:'New Playlist', edit_title:'Edit Playlist', name:'Name', name_ph:'Playlist name', desc:'Description', desc_ph:'Description', orientation:'Screen orientation', horizontal:'Horizontal (16:9)', vertical:'Vertical (9:16)', shuffle:'Shuffle order', repeat:'Loop forever', add_content:'Add content', select_file:'-- Select file --', add:'+ Add', content:'Content', empty:'Empty' },
      act: { title:'Activation Codes', gen_btn:'Generate code', code_label:'Activation code', existing:'Generated codes', dev_name:'Device name (optional)', dev_name_ph:'E.g. Reception, Waiting room...' },
      pl: { title:'Playlists', new_btn:'+ New Playlist', no_playlists:'No playlists created yet.', items:'items', empty:'Empty playlist', assign:'Assign', unassign:'Unassign', rename:'Rename', duplicate:'Duplicate' },
      dev: { title:'Device Management', add_device:'+ Add device', add_smarttv:'+ Add Smart TV', gen_code:'+ Generate Code', repair_smarttv:'Re-pair', no_devices:'No devices activated yet.', last_seen:'Last seen', temp:'Temperature', screenshot:'Screenshot', logs:'Logs', reboot:'Reboot', ssh:'SSH', unassigned:'Unassigned', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Mirror', mode_pro:'Independent' },
      wiz: { s1_title:'Add device', s1_sub:'What type of device are you connecting?', type_rpi:'SONORO Player', type_rpi_desc:'Dedicated hardware (RPi)', type_win:'SONORO Player', type_win_desc:'Windows PC', type_smarttv:'Smart TV', type_smarttv_desc:'TV with browser', next:'Next', back:'← Back', add:'Add', continue:'Continue', s2tv_title:'Add Smart TV', s2tv_sub:'Follow these steps on the TV and copy the code shown on its screen.', tv_inst_title:'On the TV', tv_inst_1:'Turn the TV on and open the browser.', tv_inst_2:'Go to <span style="background:#111;color:#c9a4ff;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:11px;">cms.sonoro.com.co/pair</span>', tv_inst_3:'Copy the 6-character code shown on screen into the field below.', code:'TV code', name:'Device name', orientation:'Orientation', s2p_title:'Generate activation code', s2p_sub:'The installer will ask for this code when setting up the device.' },
      login: { sub:'CMS · Digital Signage', tab_signin:'Sign in', tab_signup:'Sign up',
        email:'Email', password:'Password', name:'Name',
        signin_btn:'Sign in', signup_btn:'Create account',
        forgot:'Forgot your password?', forgot_send:'Send instructions',
        picker_q:'What will you use?', form_section:'Your account',
        signage_t:'Digital Signage', signage_d:'Digital signage on TVs and displays',
        events_t:'Event management', events_d:'Registration, check-in and staff' },
      topbar: { session:'Session', logout:'Log out', theme_light:'Light', theme_dark:'Dark' },
      sidebar: { group_content:'Content<br>Management', tab_content:'Content', tab_playlists:'Playlists', tab_devices:'Devices',
        tab_multisede:'Locations', tab_multiplaylist:'Schedules',
        group_licenses:'Licenses', tab_my_licenses:'My Licenses', tab_my_account:'My Account', tab_account:'Account', tab_queue:'Queue', tab_events:'Events' },
      ms: { title:'Locations', subtitle:'Organize your devices by location and push content to multiple sites at once.',
        upsell_title:'Organize your devices by location',
        upsell_desc:'Group screens by location, push the same playlist to multiple sites in one click and get per-location reports. Ideal if you operate more than one store or point of sale.',
        upsell_cta:'Contact sales →',
        pro_banner_title:'Multi-location plan active', sedes_word:'locations', devices_word:'devices', bulk_enabled:'Bulk push enabled',
        tab_sedes:'Locations', tab_bulk:'Bulk push', your_sedes:'Your locations',
        your_sedes_hint:'Each device can belong to one location. Used to filter in bulk push and per-location reports.',
        new_sede:'+ New location', modal_new_title:'New location', field_name:'Name', field_country:'Country', field_city:'City', save:'Save location' },
      mp: { title:'Schedules', subtitle:'Schedule multiple playlists per time slot on the same device.',
        upsell_title:'Schedule multiple playlists per time slot',
        upsell_desc:'Assign different lists to the same screen based on time of day — morning promo, afternoon menu, evening brand. Ideal for restaurants, retail and venues with shifting audiences.',
        upsell_cta:'Contact sales →' },
      bp: { title:'Bulk playlist push', subtitle:'Select a playlist and target locations. All filtered devices receive the same list.', pending:'Bulk push — next release (Block B).' },
      lic: { title:'My Licenses', buy_btn:'+ Buy license',
        kpi_active:'Active', kpi_trial:'Trial', kpi_expiring:'Expiring (30d)', kpi_pending:'Pending orders',
        trial_title:'Free 15-day trial', trial_sub:'Pick Smart TV or Windows. Includes 150 MB during the trial. Only one trial per account.', trial_btn:'Start trial',
        trial_modal_title:'Start free trial', trial_modal_sub:'Pick a product. 15 days · 150 MB storage · no card · one trial per account.',
        trial_modal_note:'You can activate only one trial per account and cannot switch product later.',
        trial_prod_smarttv:'Smart TV', trial_prod_smarttv_desc:'Play on your Smart TV with the SONORO Player app.',
        trial_prod_windows:'Windows', trial_prod_windows_desc:'Play on Windows PC in kiosk mode.',
        trial_activated_toast:'15-day trial activated',
        trial_ending_title:'Your trial is about to end.', trial_ending_body:'Buy a license to keep going without interruptions.',
        trial_buy_btn:'Buy license', trial_grandfathered:'Original 30-day trial with no storage limit.',
        storage_label:'Storage', storage_near:'Close to the trial limit.', storage_full:'You reached the 150 MB trial limit.',
        storage_toast_trial:'You hit 150 MB of the trial. Upgrade to a paid plan for 500 MB.', storage_toast_paid:'You reached your storage limit.',
        badge_trial:'Trial', badge_active:'Active', badge_expired:'Expired',
        expires_word:'Expires', days_word:'days', device_word:'Device', no_device:'No device assigned', renew_btn:'Renew',
        active_title:'Active licenses', history_title:'Order history',
        col_order:'Order', col_product:'Product', col_amount:'Amount', col_status:'Status', col_date:'Date', col_action:'Action',
        ev_title:'Events v1',
        ev_tier_trial:'Trial', ev_tier_lite:'Lite', ev_tier_pro:'Pro', ev_tier_masivo:'Massive',
        ev_active_sub:'Active plan · expires on',
        ev_days_left:'days left', ev_day_left:'day left',
        ev_grace_title:'Payment overdue',
        ev_grace_body:'You keep full access until',
        ev_readonly_title:'Read-only mode',
        ev_readonly_body:'You cannot create or edit events until your license is reactivated.',
        ev_no_license_title:'You don’t have Events v1 access yet',
        ev_no_license_body:'Activate a plan to start creating events.',
        ev_admin_bypass:'Admin access · no license required',
        ev_btn_pay:'Pay now', ev_btn_reactivate:'Reactivate', ev_btn_plans:'See plans', ev_btn_manage:'Manage' },
      mc: { title:'My Account', personal_info:'Personal information',
        email:'Email', name:'Name', role:'Role', country:'Country',
        change_pw:'Change password', pw_current:'Current password', pw_new:'New password (min. 8)', pw_confirm:'Confirm new password', change_pw_btn:'Change password',
        role_admin:'Administrator', role_agent:'Agent', role_client:'Client' },
      stv: { horizontal:'Horizontal', vertical:'Vertical', err_invalid_code:'Invalid code (6 characters A-Z, 0-9).' },
      usd: { title:'New order — International', sub:'Choose product and subscribe via PayPal.', product:'Product', prod_smarttv:'SONORO Smart TV — monthly subscription', prod_windows:'SONORO Windows — monthly subscription', prod_player:'SONORO Player — monthly subscription', amount:'Amount', pay_paypal:'Pay with PayPal', subscribe:'Subscribe on PayPal', create_order:'Create order' },
      pro: { badge:'Pro Plan active', desc:'— push the same playlist to multiple screens and group them by location.', tags:'Bulk Push · Multi-site · Reports by location', cta:'Go to Sites & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Log out' },
      sb: { mi_cuenta:'My Account', resumen:'Overview', mis_dispositivos:'My Devices', mis_sedes:'My Sites', ver_sedes:'View Sites', contenido:'Content', bulkpush:'Bulk Push' },
      ov: { title:'Overview', refresh:'Refresh', server:'CMS Server', operative:'Operational', devices:'Devices', sedes:'Sites', playlists:'Active playlists', playing_now:'playing now', content:'Content', files:'files', status_by_sede:'Status by site', loading_sedes:'Loading sites...' },
      md: { title:'My Devices', sub:'Devices assigned to your account' },
      bp: { title:'Bulk Push', sub:'Push a playlist to multiple devices at once',
        step_playlist:'Playlist', step_dest:'Destination', step_format:'Format', step_confirm:'Confirm',
        s1_label:'1 — Playlist to push', select_playlist:'— Select playlist —',
        s2_label:'2 — Geographic destination level', country:'Country', city:'City', branch:'Site', all_f:'All', route:'Route:',
        s3_label:'3 — Screen format', all_sub:'No orientation filter', horizontal:'Horizontal', horizontal_sub:'Landscape screens', vertical:'Vertical', vertical_sub:'Portrait screens',
        s4_label:'4 — Preview and confirm', preview:'Preview', recv_title:'Devices that will receive the playlist', devices:'devices',
        th_device:'Device', th_city_branch:'City / Site', th_ports:'Ports', th_current:'Current playlist', th_action:'Action', send_all:'Send to all' },
      ev: { tab:'My Events', title_my:'My Events', new_btn:'+ New Event', title_new:'New Event', back:'Back', back_list:'My Events', cancel:'Cancel', create:'Create Event', delete_event:'Delete event', filter_all:'All', filter_matchmaking:'Matchmaking', new_type_label:'Type', new_type_std:'Standard event', new_type_rn:'Matchmaking round', new_rn_mode:'Matching mode', new_rn_mode_auto:'Automatic by interests (tags)', new_rn_mode_manual:'Manual only', new_rn_zone:'Zone', new_rn_zone_classic:'Classic (single zone)', new_rn_zone_zoned:'Zoned',
            sub_info:'Information', sub_form:'Form', sub_regs:'Registrations', sub_staff:'Staff', sub_suppliers:'Suppliers', sub_rundown:'Production', sub_certs:'Certificates',
            f_name:'Event name *', f_start:'Start date *', f_end:'End date *', f_tz:'Time zone', f_capacity:'Max capacity', f_desc:'Description', f_venue:'Venue',
            card_data:'Event data', c_name:'Name', c_desc:'Description', c_venue:'Venue', c_capacity:'Capacity', c_start:'Start date', c_end:'End date', c_tz:'Time zone',
            publish_cal:'Publish in my external calendar',
            no_events:"You haven't created any events yet.",
            save:'Save changes',
            f_name_ph:'E.g. SONORO Convention 2026', f_capacity_ph:'E.g. 500', f_desc_ph:'Public description of the event…', f_venue_ph:'E.g. Hotel Tequendama, Bogotá',
            inf_ticket_types:'Ticket types', inf_ticket_types_hint:'one per line · empty = only "general"', inf_ticket_types_ph:'Write one type per line, e.g.:\nGeneral\nVIP\nSpeaker',
            sess_card:'Sessions / Days', sess_add:'+ Add', sess_regmode_label:'Registration type:',
            sess_regmode_full:'General registration (all sessions)', sess_regmode_per:'Multi-session (register to specific sessions)',
            sess_regmode_help:'Private or invite-only sessions never appear in the public form.',
            sess_f_name:'Session name', sess_f_name_ph:'E.g. Day 1 — Morning',
            sess_f_speaker:'Speaker', sess_f_speaker_ph:'Speaker name (optional)',
            sess_f_date:'Date', sess_f_cap:'Capacity (opt.)', sess_f_cap_ph:'No limit',
            sess_f_start:'Start time', sess_f_end:'End time',
            sess_f_staff:'Owner', sess_staff_none:'— Unassigned —',
            sess_f_obs:'Notes', sess_f_obs_ph:'Notes or special instructions…',
            sess_f_visibility:'Visibility',
            sess_vis_public:'Public — anyone can see and register',
            sess_vis_private:'Private — only the producer assigns it manually',
            sess_vis_invite:'Invite-only — requires invitation link',
            sess_save:'Save session',
            mail_card:'Email settings',
            mail_from:'Sender name', mail_from_hint:'(shown in the recipient inbox)', mail_from_ph:'SONORO CMS (default)',
            mail_reply:'Reply-To', mail_reply_hint:'(who the recipient replies to)', mail_reply_ph:'Empty = no reply-to',
            mail_note:'Emails are always sent from <strong>cms@sonoro.com.co</strong>. The sender name and Reply-To are visible to the recipient. Applies to registration confirmations and supplier quote emails.',
            fm_confirm_mode:'Confirmation mode',
            fm_conf_auto:'Automatic confirmation', fm_conf_auto_d:'On signup the pass with QR code is sent immediately',
            fm_conf_manual:'Manual confirmation', fm_conf_manual_d:'The registrant is told they will be confirmed by the event team. The QR pass is sent after confirming from the dashboard',
            fx_title:'Fixed fields — always present',
            fx_fullname:'Full name', fx_email:'Email address', fx_phone:'Phone (+prefix)', fx_doc:'Document type + number', fx_ticket:'Ticket type',
            fm_active:'Fields in the form',
            fcat_title:'Fields available to add',
            fm_new_custom:'Create custom field', fm_type_label:'Type:',
            fm_type_text:'Text', fm_type_select:'Select', fm_type_bool:'Yes / No', fm_type_tel:'Phone',
            fm_save:'Save form', fm_preview:'Preview',
            fmod_title:'New field',
            fmod_label_es:'Label ES', fmod_label_es_ph:'E.g. Empresa',
            fmod_label_en:'Label EN', fmod_label_en_ph:'e.g. Company',
            fmod_required:'Required field',
            fmod_opts:'Options', fmod_opt_ph:'New option…', fmod_opt_add:'+ Add',
            fmod_cond:'Show only if… (optional)',
            fmod_cond_always:'— Always visible —', fmod_cond_ticket:'Ticket type =',
            fmod_cond_val_ph:'e.g. vip',
            fmod_add:'Add to form',
            reg_links:'Event links',
            reg_link_public:'Public registration', reg_link_app:'Check-in App', reg_link_kiosko:'Kiosk check-in',
            reg_open:'Open',
            reg_search_ph:'Search by name or email…',
            reg_import:'Import CSV/XLSX', reg_template:'Template', reg_template_title:'XLSX template with this event form columns + instructions',
            reg_export_csv:'Export CSV', reg_export_pdf:'Export PDF',
            reg_print_all:'Print all', reg_print_all_title:'Print QR labels for all registrations',
            reg_th_name:'Name', reg_th_email:'Email', reg_th_type:'Type', reg_th_status:'Status', reg_th_date:'Registered',
            stf_card:'Event team', stf_add:'+ Add',
            stf_new_title:'New staff member',
            stf_name:'Name *', stf_name_ph:'E.g. Juan Pérez',
            stf_role:'Role *', stf_role_select:'— Select —',
            stf_role_coord:'Coordinator', stf_role_reg:'Registration Coordinator', stf_role_tech:'Technical Coordinator',
            stf_role_host:'Host Coordinator', stf_role_sec:'Security Coordinator',
            stf_role_cat:'Catering Coordinator', stf_role_art:'Artistic & Entertainment Coordinator',
            stf_role_other:'Other',
            stf_email:'Email', stf_email_ph:'optional',
            stf_phone:'Phone', stf_phone_ph:'optional',
            stf_pin:'Access PIN (check-in)', stf_pin_gen:'Generate', stf_pin_ph:'6 digits — generated automatically',
            stf_locale:'Staff language (emails)',
            stf_locale_es:'Spanish', stf_locale_en:'English', stf_locale_pt:'Portuguese (BR)',
            stf_custom:'Personal message (optional)', stf_custom_ph:'E.g. María, arrive at 5:45 PM to coordinate the VIP badges…',
            stf_custom_hint:'This text is appended to the briefing email as "Message from the producer".',
            stf_save:'Save',
            stf_pool_title:'Staff catalog', stf_pool_hint:'Reusable across events. Add here to avoid re-typing data.',
            stf_pool_search_ph:'Search…', stf_pool_manage:'Manage catalog →',
            sup_budget_card:'Event budget', sup_csv_title:'Download CSV', sup_pdf_title:'Download PDF', sup_budget_edit:'Edit budget',
            sup_budget_ph:'Total budget (COP)', sup_save:'Save',
            sup_card_budget:'Budget', sup_card_cot:'Total quoted', sup_card_appr:'Total approved', sup_card_paid:'Total paid', sup_card_bal:'Available balance',
            sup_card_title_budget:'Maximum budget allocated to the event',
            sup_card_title_cot:'Sum of quotes received or accepted',
            sup_card_title_appr:'Sum of accepted contracts (committed)',
            sup_card_title_paid:'Money already out: advances + paid',
            sup_card_title_bal:'Budget minus total approved (can be negative)',
            sup_contracts:'Suppliers', sup_contract_add:'+ Add',
            sup_c_supplier:'Supplier from directory *', sup_c_supplier_sel:'— Select supplier —',
            sup_c_role:'Service description', sup_c_role_ph:'E.g. Main audio, Photo coverage',
            sup_c_amount:'Approximate budget (COP)',
            sup_c_notes:'Notes', sup_c_notes_ph:'Observations',
            sup_dir:'Supplier directory', sup_dir_new:'+ New',
            sup_d_name:'Name *', sup_d_name_ph:'Company or person name',
            sup_d_cat:'Category', sup_d_cat_ph:'E.g. Audio, Photo, Catering',
            sup_d_contact:'Contact', sup_d_contact_ph:'Contact name',
            sup_d_phone:'Phone', sup_d_phone_ph:'+57 300 0000000',
            sup_d_email:'Email', sup_d_email_ph:'supplier@example.com',
            sup_d_id_type:'ID type', sup_d_id_num:'ID number', sup_d_id_num_ph:'900.123.456-7',
            sup_d_locale:'Supplier language (emails)',
            sup_d_docs:'Legal documents', sup_d_doc_rut:'RUT', sup_d_doc_cert:'Bank cert.', sup_d_doc_camara:'Trade registry',
            prod_dash_title:'Production dashboard', prod_dash_tag:'Producer',
            prod_dash_desc:'Live control monitor: stats, timer, sessions and channel to screens. Main screen for the general producer.',
            prod_open_newtab:'Open in new tab', prod_copy_url:'Copy URL', prod_revoke:'Revoke token', prod_gen_url:'Generate public URL',
            prod_tp_title:'Teleprompter', prod_tp_tag:'Speaker',
            prod_tp_desc:"Clean view for the speaker's confidence monitor: session name, giant timer, what's next. Separate URL per session.",
            prod_tp_session:'Session:', prod_tp_nosess:'No sessions',
            prod_tp_open:'Open', prod_tp_copy:'Copy', prod_tp_wa:'WhatsApp', prod_tp_revoke:'Revoke',
            prod_tp_gen:'Generate URL for this session',
            prod_libreto:'Event rundown', prod_cue_add:'+ Add cue',
            prod_cue_num:'No.', prod_cue_num_ph:'01',
            prod_cue_title_lbl:'Title *', prod_cue_title_ph:'Event opening',
            prod_cue_sched:'Scheduled time *',
            prod_cue_dur:'Duration (min)', prod_cue_dur_ph:'30',
            prod_cue_zone:'Zone / Space', prod_cue_zone_ph:'Main auditorium',
            prod_cue_resp:'Owner',
            prod_cue_notes:'Technical notes', prod_cue_notes_ph:'Audio: wireless mic. Video: slide 1…',
            prod_th_num:'No.', prod_th_time:'Time', prod_th_title:'Title', prod_th_dur:'Dur.', prod_th_zone:'Zone', prod_th_status:'Status',
            cert_intro_title:'Event certificates',
            cert_intro_desc:'Design your certificate as a background image (canvas). The system only overlays dynamic data: name, event, session, hours, date and verification QR.',
            cert_guide:'Open design guide',
            cert_tpls:'Templates', cert_tpl_new:'New template',
            cert_issued:'Issued', cert_search_ph:'Search…', cert_bulk:'Bulk issue',
            cert_th_att:'Attendee', cert_th_tpl:'Template', cert_th_hours:'Hours', cert_th_issued:'Issued', cert_th_status:'Status',
            manage:'Manage', publish:'Publish', unpublish:'Unpublish',
            unpublish_confirm:'Unpublish the event? The public page will no longer be accessible.',
            list_loading:'Loading events…', list_empty_title:'No events yet', list_empty_sub:'Create your first event to get started.', list_error:'Error loading events.',
            panel: { title:'Summary panel', sub_default:'Aggregated view of your events · last 12 months', sub_30d:'Aggregated view · last 30 days', sub_90d:'Aggregated view · last 90 days', sub_12m:'Aggregated view · last 12 months', sub_ytd:'Aggregated view · year to date', sub_all:'Aggregated view · all time', r_ytd:'YTD', r_all:'All', collapse:'Collapse / expand', k_events:'Events held', k_done:'Held', k_sched:'Scheduled', k_cancel:'Cancelled', k_done_sub:'of 0 total', k_done_sub_tpl:'of {total} total', k_att:'Attendees', k_att_sub:'attended (of 0)', k_att_sub_tpl:'attended (of {reg})', k_checkin:'Check-in', k_noshow:'No show', k_proj:'Projected budget', k_total:'Total', k_avg:'Average per event', k_paid:'Paid budget', k_paid_sub:'paid to suppliers', k_paid_lbl:'Paid', k_pending:'Pending', events_word:'events', top5_title:'Top events by attendance', top5_empty:'No events held in range.', monthly_title:'Events per month', day:'day', days:'days', attendees_short:'att', tier_badge:'Pro · Masivo', teaser_title:'Summary panel', teaser_body:'See aggregated metrics across all your events: attendees, projected vs executed budget, top events and monthly trend. Export PDF and Excel reports.', teaser_cta:'View plans', export_err:'Report could not be generated.' },
            sess_edit:'Edit', sess_loading:'Loading…', sess_empty:'No sessions. Add one above.', sess_error:'Error loading sessions.',
            sess_cap_word:'seats', sess_vis_private_badge:'PRIVATE', sess_vis_invite_badge:'INVITE-ONLY',
            fm_empty:'No fields added yet.', fcat_all_added:'All available fields are already in the form.',
            fcat_add:'+ Add to form', fcat_cond:'COND.', fcat_remove:'Remove', fcat_required:'required', fcat_only_if:'only if',
            fcat_organization:'Company / Institution', fcat_job_title:'Job title', fcat_dietary:'Dietary restriction', fcat_tshirt_size:'T-shirt size',
            fcat_emergency:'Emergency contact', fcat_emergency_ph:'Emergency phone', fcat_eps:'Health insurance', fcat_blood_type:'Blood type',
            fcat_transport:'Interested in transport & accommodation offers?', fcat_tourism:'Interested in tourism info & complementary plans?',
            fcat_attended:'Have you attended previous events?',
            reg_cancel:'Cancel', reg_confirm:'Confirm', reg_edit:'Edit',
            reg_assign_session:'Assign session', reg_cert:'Certificate', reg_delete:'Delete',
            reg_status_confirmed:'Confirmed', reg_status_cancelled:'Cancelled', reg_status_pending:'Pending',
            reg_no_results:'No registrations.', reg_error:'Error loading registrations.',
            reg_extra_tel:'Phone:', reg_extra_id:'ID:', reg_extra_company:'Company:', reg_extra_role:'Role:',
            reg_no_extra:'No additional data', reg_sessions_label:'Sessions:', reg_checkins:'Check-ins',
            reg_checkin_general:'General entry', reg_checkin_session:'Session', reg_no_checkins:'No check-ins recorded',
            reg_certs:'Certificates', reg_edit_title:'Edit attendee data', reg_print_title:'Print QR label',
            reg_assign_title:'Assign or remove sessions (includes private)', reg_cert_title:'Issue / manage certificate',
            regs_stat_of:'of', regs_stat_seats_word:'seats', regs_stat_no_limit:'no capacity limit',
            regs_stat_registered:'Registered', regs_stat_confirmed:'Confirmed', regs_stat_of_registered:'registered',
            regs_stat_pending:'Pending', regs_stat_pending_sub:'pending confirmation',
            regs_chart_title:'Check-ins per session',
            stf_add_to_event:'+ Add to event',
            stf_pool_empty:'Catalog empty. Create reusable staff from the Staff tab in the sidebar.',
            stf_pool_no_results:'No results.', stf_pool_loading:'Loading…', stf_pool_error:'Error loading catalog.',
            stf_send_briefing:'Send briefing', stf_briefing_sent:'Briefing sent on',
            stf_briefing_title:'Send briefing by email', stf_pin_title:'Check-in PIN',
            sup_budget_undefined:'Not defined', sup_edit:'Edit',
            sup_contracts_empty:'No suppliers yet.',
            sup_dir_empty:'Directory empty. Add frequent suppliers to reuse them in future events.',
            sup_deposit:'Deposit:', sup_deposit_of:'of', sup_view_quote:'View quote', sup_waiting_resp:'Awaiting resp.',
            sup_request_quote:'Request quote', sup_see_proof:'View proof', sup_upload_proof:'Upload proof',
            sup_abono_q:'How much was the deposit?', sup_abono_ph:'Deposit amount (COP)', sup_abono_confirm:'Confirm', sup_cancel:'Cancel',
            sup_hist_accepted:'Accepted', sup_hist_partial:'Deposit', sup_hist_paid:'Full payment', sup_hist_rejected:'Rejected', sup_hist_cancelled:'Cancelled',
            cert_edit:'Edit', cert_preview:'Preview', cert_delete:'Delete', cert_resend:'Resend', cert_revoke:'Revoke',
            cert_tpl_empty:'No templates yet. Create one to start issuing certificates.',
            cert_issued_empty:'No certificates issued yet.',
            cert_reg_empty:'This attendee has no certificates issued yet.',
            cert_tpl_scope_session:'Specific session', cert_tpl_scope_event:'Full event',
            cert_tpl_page_half:'Half letter', cert_tpl_page_letter:'Letter',
            cert_tpl_active:'Active', cert_tpl_inactive:'Inactive',
            cert_tpl_canvas_ok:'Canvas loaded', cert_tpl_canvas_missing:'No canvas',
            cert_tpl_issued_count:'issued', cert_tpl_edit:'Edit template', cert_tpl_new:'New template',
            cert_state_revoked:'Revoked', cert_state_sent:'Sent', cert_state_issued:'Issued',
            prod_cue_empty:'No cues. Add the first one with the button above.',
            prod_status_pending:'Pending', prod_status_in_progress:'In progress', prod_status_done:'Finished',
            prod_status_skipped:'Skipped', prod_status_delayed:'Delayed', prod_cue_edit:'Edit',
            toast_ev_created:'Event created', toast_ev_updated:'Event updated', toast_ev_deleted:'Event deleted',
            toast_ev_published:'Event published — the public page is now live', toast_ev_unpublished:'Event unpublished',
            toast_sess_added:'Session added', toast_sess_updated:'Session updated', toast_sess_deleted:'Session deleted', toast_sess_updated_bulk:'Sessions updated',
            toast_form_saved:'Form saved',
            toast_staff_added:'Staff added', toast_staff_created:'Staff created', toast_staff_updated:'Staff updated', toast_staff_deleted:'Staff deleted',
            toast_briefing_sent:'Briefing sent to {name}',
            toast_sup_added:'Supplier added', toast_sup_created:'Supplier created', toast_sup_updated:'Supplier updated', toast_sup_saved_dir:'Supplier saved to directory',
            toast_sup_removed_ev:'Supplier removed from event', toast_sup_removed_dir:'Supplier removed from directory',
            toast_budget_saved:'Budget saved', toast_price_updated:'Price updated',
            toast_quote_sent:'Quote sent to {email}',
            toast_doc_saved:'Document saved', toast_receipt_saved:'Receipt saved',
            toast_cue_added:'Cue added', toast_cue_updated:'Cue updated', toast_cue_deleted:'Cue deleted',
            toast_cert_tpl_created:'Template created', toast_cert_tpl_updated:'Template updated', toast_cert_tpl_deleted:'Template deleted', toast_cert_revoked:'Certificate revoked',
            toast_mail_resent:'Email resent', toast_qr_resent:'QR resent to {email}',
            toast_reg_updated:'Registration updated', toast_reg_deleted:'Registration deleted',
            toast_url_generated:'Public URL generated', toast_url_copied:'URL copied', toast_link_copied:'Link copied', toast_staff_link_copied:'Link copied — valid 24h. Send it to the staff.',
            toast_cal_disconnected:'Calendar disconnected',
            confirm_ev_del:'Delete "{name}"?\n\nThis is irreversible: all registrations, check-ins and event data will be erased.',
            confirm_sess_del:'Delete this session?',
            confirm_reg_del:'Permanently delete this registration? This cannot be undone.',
            confirm_qr_resend:'Resend the QR email to the attendee?',
            confirm_staff_remove:'Remove "{name}" from staff?',
            confirm_staff_pool_remove:'Remove "{name}" from this event?',
            confirm_staff_cat_del:'Delete "{name}" from the catalog? Past event assignments are kept.',
            confirm_sup_del_dir:'Delete "{name}" from the directory? This cannot be undone.',
            confirm_sup_dir_del:'Delete "{name}" from the directory?',
            confirm_cal_disc:'Disconnect this calendar?',
            confirm_cert_tpl_del:'Delete this template? If it already has issued certificates, it will be marked inactive.',
            confirm_token_revoke:'Revoke this token? The current URL will stop working.',
            confirm_quote_send:'Send the quote form to {email}?',
            confirm_price_update:'Update the contracted amount to {amount}?',
            confirm_cue_del:'Delete this cue?',
            confirm_contract_accepted:'Accept this quote? It will be recorded as approved in the history.',
            confirm_contract_rejected:'Mark as rejected? The supplier will be removed from the budget.',
            confirm_contract_paid:'Confirm full payment? It will be recorded in the history.',
            confirm_contract_cancelled:'Cancel this contract? The action will be recorded.',
            err_generic:'Error', err_network:'Connection error', err_save:'Could not save', err_delete:'Could not delete', err_load:'Could not load', err_send:'Could not send', err_add:'Could not add',
            err_name_required:'Name is required', err_role_required:'Select a role', err_role_before_send:'Select a role before sending', err_session_required:'Select the session', err_tpl_required:'Select a template', err_valid_amount:'Enter a valid amount', err_valid_value:'Enter a valid value', err_open_event_first:'Open an event first', err_name_dates_required:'Name, date and times are required', err_name_dates_short:'Name and dates are required', err_title_time_required:'Title and time are required',
            err_create_event:'Error creating event', err_load_event:'Error loading event', err_load_staff:'Error loading staff', err_load_sup:'Error loading suppliers', err_load_invitations:'Error loading invitations', err_load_quote:'Error loading quote',
            err_generate_link:'Error generating link', err_generate_token:'Error generating token', err_generate_preview:'Error generating preview', err_generate_pdf:'Error generating PDF', err_generate_csv:'Error generating CSV', err_generate_tpl:'Error generating template', err_dl_tpl:'Error downloading template', err_export_csv:'Error exporting CSV', err_import:'Error importing file',
            err_disconnect:'Error disconnecting', err_revoke:'Error revoking', err_resend:'Error resending', err_popup_blocked:'Allow pop-ups to print', err_print_prep:'Error preparing print',
            err_send_quote:'Error sending quote', err_update_price:'Error updating price', err_update_status:'Error updating status', err_del_event:'Error deleting event', err_upload_doc:'Error uploading document', err_upload_receipt:'Error uploading receipt', err_save_budget:'Error saving budget', err_save_cue:'Error saving cue', err_del_cue:'Error deleting cue',
            err_briefing:'Error sending briefing', err_staff_notfound:'Staff not found', err_staff_noemail:'This staff has no email', err_add_sup_dir_first:'First add suppliers to the directory', err_select_sup:'Select a supplier from the directory', err_no_quote:'No quote available', err_first_create_tpl:'First create a template', err_save_resend:'Saved, but error resending: {msg}' },
      toast: { language_updated:'Language updated' },
      rn: {
        hdr: { panel:'Producer panel', link:'Link', link_title:'Copy public link', back:'My Events', status_published:'Published', status_draft:'Draft', status_live:'Live', status_closed:'Closed', status_archived:'Archived', sub_mode:'mode', sub_zone:'zone' },
        donut: { complete_k:'Ready to match', complete:'Complete', incomplete:'Incomplete', mix_k:'Company mix', offer:'Offers', demand:'Seeks', both:'Both', util_k:'Slot utilization', booked:'Booked', free:'Free' },
        kpi: { regs:'Registered companies', complete:'With complete interests', requests:'Direct requests', util:'Projected utilization' },
        subtab: { setup:'Setup', tags:'Tags', dir:'Directory', agenda:'Agenda', live:'Live', rep:'Report' },
        toast: { saving:'Saving…', saved_prefix:'Saved · ', save_err:'Save failed', net_err:'Connection error', send_ok:'Report sent', send_err:'Error sending report', send_err_cover:'EBV coverage < 20%. Confirm to send anyway.' },
        empty: { rounds_planned:'No rounds planned', tables:'No tables configured', registered:'No registrants', rounds_see_agenda:'No rounds planned (see Agenda)', meetings_open_round:'No meetings — open a round', tags_empty:'No tags · import Excel or create the first one', catalog_err_prefix:'Error loading catalog', rows:'No rows', meetings_ebv:'No meetings with EBV captured', loading:'Loading…', report_err:'Could not load the report' },
        setup: {
          c1_title:'01 · Basic info', c1_name:'Name', c1_public_url:'Public URL:', c1_starts:'Start', c1_ends:'End', c1_tz:'Timezone', c1_currency:'Base currency (EBV)', c1_deflocale:'Default language', c1_deflocale_hint:'Email language when the delegate did not choose one.', c1_venue:'Venue', c1_venue_ph:'Hotel, convention center…',
          c2_title:'02 · Operation mode', c2_classic:'Classic', c2_classic_hint:'Single floor of tables', c2_zoned:'Zoned', c2_zoned_hint:'Tables grouped in zones',
          c3_title:'03 · Matching', c3_tags:'By interests (tags)', c3_tags_hint:'Solver proposes meetings by interest overlap', c3_manual:'Manual only', c3_manual_hint:'All meetings are chosen by attendees', c3_dirview:'Default directory view', c3_dirview_match:'Match only', c3_dirview_all:'All attendees',
          c4_title:'04 · Visibility', c4_public:'Public', c4_public_hint:'Open registration', c4_mixed:'Mixed', c4_mixed_hint:'Public + invitations', c4_private:'Private', c4_private_hint:'Invite only',
          c5_title:'05 · Schedule', c5_dur:'Meeting duration', c5_noshow:'No-show policy', c5_noshow_none:'No block', c5_buffer:'Buffer between rounds', c5_buffer_none:'No buffer', c5_autoadv:'Advance rounds automatically',
          c6_title:'06 · Options', c6_langs:'Accepted languages', c6_twodel:'Allow two attendees per company', c6_ebv:'Capture estimated business value (EBV)', c6_team:'Allow team invitations',
          discard:'Discard changes', save:'Save configuration'
        },
        tags: {
          catalog:'My catalog', count_suffix:'tags · reused across all your rounds',
          btn_template:'Template', btn_export:'Export', btn_import:'Import Excel', btn_new:'+ New tag',
          info_title:'What is the tags catalog?',
          info_p1:'Tags are the offer (what a company sells) and demand (what it looks to buy) categories that the attendee marks on registration. The Rueda engine only matches companies using tags from this catalog — so it must be ready before opening registrations.',
          info_p2:'First rueda? Download an Excel template with 2 columns (Name, Category), fill it with tags from your sector and upload it here.',
          col_name:'Name', col_id:'Identifier', col_id_title:'Normalized version of the name, auto-generated', col_cat:'Category', col_actions:'Actions', loading:'Loading…',
          new_title:'New tag', new_name:'Name', new_name_ph:'E.g. Custom software', new_name_hint:'Attendees see this when choosing their tags. Use 1 to 5 words.',
          new_fuzzy_title:'Did you mean one of these?', new_fuzzy_hint:'If none applies, continue with your tag. Avoiding duplicates improves matching.',
          new_cat:'Category (optional)', new_cat_ph:'E.g. Technology', new_cat_hint:'Groups related tags in the attendee form (e.g. Logistics, Technology, Agro).',
          new_create:'Create tag',
          edit_title:'Edit tag', save_changes:'Save changes',
          bulk_title:'Preview · import catalog', bulk_det:'Detected', bulk_new:'New', bulk_sim:'Similar', bulk_dup:'Duplicates',
          bulk_hint:'Review each row and decide. Nothing is saved until you confirm.', bulk_confirm:'Confirm',
          bulk_confirm_fmt_one:'Confirm and create 1 tag', bulk_confirm_fmt_many:'Confirm and create {n} tags'
        },
        dir: { title:'Registered attendees', search_ph:'Search company, name, tag…', col_company:'Company', col_contact:'Contact', col_offer:'Offers', col_demand:'Seeks', col_req:'Req. in/out', col_status:'Status' },
        agenda: {
          plan_title:'Plan rounds', plan_starts:'Start', plan_total:'Rounds', plan_breakev:'Break every N', plan_gen:'Generate',
          tables_title:'Tables', tables_add:'+ Add',
          solver_title:'Solver', solver_preview:'Preview', solver_run:'Run solver', solver_reset:'Reset',
          meetings_title:'Meetings', meetings_refresh:'Refresh', col_round:'Round', col_table:'Table', col_a:'Company A', col_b:'Company B', col_origin:'Origin', col_lock:'Lock'
        },
        live: {
          callboard:'Producer callboard', checkins_suffix:'check-ins', active:'Active round', active_prefix:'Active round: ', no_active:'No open round',
          rounds:'Scheduled rounds', meetings:'Live meetings',
          col_table:'Table', col_a:'Company A', col_b:'Company B', col_origin:'Origin', col_status:'Status',
          empty:'No meetings — open a round'
        },
        rep: {
          title:'Post-event report', send:'Send report by email',
          banner_ref:'Reference data · EBV coverage < 20%. Interpret with caution.',
          banner_fx:'Several currencies detected · v1 assumes COP, totals are approximate.',
          kpi_total:'Total meetings', kpi_ebv:'With EBV', kpi_avg:'Average EBV / meeting', kpi_sum:'Total estimated EBV',
          dist:'EBV distribution', median:'Median', min:'Min', max:'Max', bilat:'Bilateral', unilat:'Unilateral', empty:'Without EBV',
          top:'Top meetings by expected value',
          col_n:'#', col_a:'Company A', col_b:'Company B', col_round_table:'Round · Table', col_type:'Type', col_horizon:'Horizon', col_value:'Value',
          empty_table:'No data — load the report',
          cov_suffix:'% coverage', sending:'Sending…'
        }
      }
    },
    'pt-BR': {
      common: { loading:'Carregando…', save:'Salvar', change:'Alterar', refresh:'↻ Atualizar', delete:'Excluir', edit:'Editar', cancel:'Cancelar', close:'Fechar', copy:'Copiar', copied:'Copiado', yes:'Sim', no:'Não', online:'On-line', offline:'Off-line' },
      cnt: { title:'Gerenciador de Conteúdo', upload_title:'Enviar Arquivo', upload_btn:'↑ Enviar', uploading:'Enviando', preview:'Pré-visualização', files:'Arquivos', choose_file:'Escolher arquivo', no_file:'Sem arquivo', no_files:'Nenhum conteúdo enviado ainda.', assigned_to:'Atribuído a', duration:'Duração', size:'Tamanho', type_video:'Vídeo', type_image:'Imagem' },
      plm: { new_title:'Nova Playlist', edit_title:'Editar Playlist', name:'Nome', name_ph:'Nome da playlist', desc:'Descrição', desc_ph:'Descrição', orientation:'Orientação da tela', horizontal:'Horizontal (16:9)', vertical:'Vertical (9:16)', shuffle:'Ordem aleatória', repeat:'Repetir infinitamente', add_content:'Adicionar conteúdo', select_file:'-- Selecionar arquivo --', add:'+ Adicionar', content:'Conteúdo', empty:'Vazio' },
      act: { title:'Códigos de Ativação', gen_btn:'Gerar código', code_label:'Código de ativação', existing:'Códigos gerados', dev_name:'Nome do dispositivo (opcional)', dev_name_ph:'Ex: Recepção, Sala de espera...' },
      pl: { title:'Playlists', new_btn:'+ Nova Playlist', no_playlists:'Nenhuma playlist criada ainda.', items:'itens', empty:'Playlist vazia', assign:'Atribuir', unassign:'Desatribuir', rename:'Renomear', duplicate:'Duplicar' },
      dev: { title:'Gestão de Dispositivos', add_device:'+ Adicionar dispositivo', add_smarttv:'+ Adicionar Smart TV', gen_code:'+ Gerar Código', repair_smarttv:'Re-parear', no_devices:'Nenhum dispositivo ativado ainda.', last_seen:'Última conexão', temp:'Temperatura', screenshot:'Captura', logs:'Registros', reboot:'Reiniciar', ssh:'SSH', unassigned:'Não atribuído', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Espelho', mode_pro:'Independente' },
      wiz: { s1_title:'Adicionar dispositivo', s1_sub:'Que tipo de dispositivo você vai conectar?', type_rpi:'SONORO Player', type_rpi_desc:'Hardware dedicado (RPi)', type_win:'SONORO Player', type_win_desc:'Windows PC', type_smarttv:'Smart TV', type_smarttv_desc:'TV com navegador', next:'Próximo', back:'← Voltar', add:'Adicionar', continue:'Continuar', s2tv_title:'Adicionar Smart TV', s2tv_sub:'Siga estes passos no TV e copie o código exibido na tela.', tv_inst_title:'No TV', tv_inst_1:'Ligue o TV e abra o navegador.', tv_inst_2:'Acesse <span style="background:#111;color:#c9a4ff;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:11px;">cms.sonoro.com.co/pair</span>', tv_inst_3:'Copie abaixo o código de 6 caracteres exibido na tela.', code:'Código do TV', name:'Nome do dispositivo', orientation:'Orientação', s2p_title:'Gerar código de ativação', s2p_sub:'O instalador pedirá este código ao configurar o dispositivo.' },
      login: { sub:'CMS · Sinalização Digital', tab_signin:'Entrar', tab_signup:'Cadastrar',
        email:'E-mail', password:'Senha', name:'Nome',
        signin_btn:'Entrar', signup_btn:'Criar conta',
        forgot:'Esqueceu sua senha?', forgot_send:'Enviar instruções',
        picker_q:'O que você vai usar?', form_section:'Sua conta',
        signage_t:'Telas informativas', signage_d:'Sinalização digital em TVs e monitores',
        events_t:'Gestão de eventos', events_d:'Inscrição, check-in e equipe' },
      topbar: { session:'Sessão', logout:'Sair', theme_light:'Claro', theme_dark:'Escuro' },
      sidebar: { group_content:'Gestão de<br>Conteúdo', tab_content:'Conteúdo', tab_playlists:'Playlists', tab_devices:'Dispositivos',
        tab_multisede:'Filiais', tab_multiplaylist:'Programações',
        group_licenses:'Licenças', tab_my_licenses:'Minhas Licenças', tab_my_account:'Minha Conta', tab_account:'Conta', tab_queue:'Senhas', tab_events:'Eventos' },
      ms: { title:'Filiais', subtitle:'Organize seus dispositivos por localização e envie conteúdo para várias filiais ao mesmo tempo.',
        upsell_title:'Organize seus dispositivos por filial',
        upsell_desc:'Agrupe telas por localização, envie a mesma playlist para várias filiais em um clique e obtenha relatórios por localização. Ideal se você opera mais de uma loja ou ponto de venda.',
        upsell_cta:'Falar com comercial →',
        pro_banner_title:'Plano Multi-filial ativo', sedes_word:'filiais', devices_word:'dispositivos', bulk_enabled:'Envio em massa habilitado',
        tab_sedes:'Filiais', tab_bulk:'Envio em massa', your_sedes:'Suas filiais',
        your_sedes_hint:'Cada dispositivo pode pertencer a uma filial. Usado para filtrar no envio em massa e relatórios por localização.',
        new_sede:'+ Nova filial', modal_new_title:'Nova filial', field_name:'Nome', field_country:'País', field_city:'Cidade', save:'Salvar filial' },
      mp: { title:'Programações', subtitle:'Programe várias playlists por faixa horária no mesmo dispositivo.',
        upsell_title:'Programe várias playlists por faixa horária',
        upsell_desc:'Atribua listas diferentes à mesma tela conforme a hora do dia — manhã promo, tarde menu, noite marca. Ideal para restaurantes, varejo e espaços com públicos variáveis.',
        upsell_cta:'Falar com comercial →' },
      bp: { title:'Envio em massa de playlist', subtitle:'Selecione uma playlist e as filiais destino. Todos os dispositivos filtrados recebem a mesma lista.', pending:'Envio em massa — próxima entrega (Bloco B).' },
      lic: { title:'Minhas Licenças', buy_btn:'+ Comprar licença',
        kpi_active:'Ativas', kpi_trial:'Em teste', kpi_expiring:'A vencer (30d)', kpi_pending:'Pedidos pendentes',
        trial_title:'Teste grátis por 15 dias', trial_sub:'Escolha Smart TV ou Windows. Inclui 150 MB durante o teste. Somente um teste por conta.', trial_btn:'Ativar teste',
        trial_modal_title:'Ativar teste grátis', trial_modal_sub:'Escolha um produto. 15 dias · 150 MB de armazenamento · sem cartão · somente um teste por conta.',
        trial_modal_note:'Você pode ativar apenas um teste por conta e não poderá trocar de produto depois.',
        trial_prod_smarttv:'Smart TV', trial_prod_smarttv_desc:'Reproduza na sua Smart TV com o app SONORO Player.',
        trial_prod_windows:'Windows', trial_prod_windows_desc:'Reproduza em PC Windows em modo quiosque.',
        trial_activated_toast:'Teste de 15 dias ativado',
        trial_ending_title:'Seu teste está por acabar.', trial_ending_body:'Compre uma licença para continuar sem interrupções.',
        trial_buy_btn:'Comprar licença', trial_grandfathered:'Teste original de 30 dias sem limite de armazenamento.',
        storage_label:'Armazenamento', storage_near:'Perto do limite do teste.', storage_full:'Você atingiu o limite de 150 MB do teste.',
        storage_toast_trial:'Você atingiu 150 MB do teste. Atualize para um plano pago para 500 MB.', storage_toast_paid:'Você atingiu seu limite de armazenamento.',
        badge_trial:'Teste', badge_active:'Ativa', badge_expired:'Vencida',
        expires_word:'Vence', days_word:'dias', device_word:'Dispositivo', no_device:'Sem dispositivo atribuído', renew_btn:'Renovar',
        active_title:'Licenças ativas', history_title:'Histórico de pedidos',
        col_order:'Pedido', col_product:'Produto', col_amount:'Valor', col_status:'Status', col_date:'Data', col_action:'Ação',
        ev_title:'Events v1',
        ev_tier_trial:'Trial', ev_tier_lite:'Lite', ev_tier_pro:'Pro', ev_tier_masivo:'Massivo',
        ev_active_sub:'Plano ativo · vence em',
        ev_days_left:'dias restantes', ev_day_left:'dia restante',
        ev_grace_title:'Pagamento vencido',
        ev_grace_body:'Você mantém acesso completo até',
        ev_readonly_title:'Modo somente leitura',
        ev_readonly_body:'Você não pode criar nem editar eventos até reativar a licença.',
        ev_no_license_title:'Ainda não tem acesso ao Events v1',
        ev_no_license_body:'Ative um plano para começar a criar eventos.',
        ev_admin_bypass:'Acesso de administrador · sem licença necessária',
        ev_btn_pay:'Pagar agora', ev_btn_reactivate:'Reativar', ev_btn_plans:'Ver planos', ev_btn_manage:'Gerenciar' },
      mc: { title:'Minha Conta', personal_info:'Informações pessoais',
        email:'E-mail', name:'Nome', role:'Função', country:'País',
        change_pw:'Alterar senha', pw_current:'Senha atual', pw_new:'Nova senha (mín. 8)', pw_confirm:'Confirmar nova senha', change_pw_btn:'Alterar senha',
        role_admin:'Administrador', role_agent:'Agente', role_client:'Cliente' },
      stv: { horizontal:'Horizontal', vertical:'Vertical', err_invalid_code:'Código inválido (6 caracteres A-Z, 0-9).' },
      usd: { title:'Novo pedido — Internacional', sub:'Escolha o produto e assine via PayPal.', product:'Produto', prod_smarttv:'SONORO Smart TV — assinatura mensal', prod_windows:'SONORO Windows — assinatura mensal', prod_player:'SONORO Player — assinatura mensal', amount:'Valor', pay_paypal:'Pagamento com PayPal', subscribe:'Assinar no PayPal', create_order:'Criar pedido' },
      pro: { badge:'Plano Pro ativo', desc:'— envie a mesma playlist para várias telas e agrupe-as por local.', tags:'Bulk Push · Multi-sede · Relatórios por local', cta:'Ir para Sedes & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Sair' },
      sb: { mi_cuenta:'Minha Conta', resumen:'Resumo', mis_dispositivos:'Meus Dispositivos', mis_sedes:'Minhas Sedes', ver_sedes:'Ver Sedes', contenido:'Conteúdo', bulkpush:'Bulk Push' },
      ov: { title:'Resumo', refresh:'Atualizar', server:'Servidor CMS', operative:'Operacional', devices:'Dispositivos', sedes:'Sedes', playlists:'Playlists ativas', playing_now:'em reprodução agora', content:'Conteúdo', files:'arquivos', status_by_sede:'Status por sede', loading_sedes:'Carregando sedes...' },
      md: { title:'Meus Dispositivos', sub:'Dispositivos atribuídos à sua conta' },
      bp: { title:'Bulk Push', sub:'Envio em massa de playlist para vários dispositivos',
        step_playlist:'Playlist', step_dest:'Destino', step_format:'Formato', step_confirm:'Confirmar',
        s1_label:'1 — Playlist a enviar', select_playlist:'— Selecionar playlist —',
        s2_label:'2 — Nível geográfico de destino', country:'País', city:'Cidade', branch:'Sede', all_f:'Todas', route:'Rota:',
        s3_label:'3 — Formato de tela', all_sub:'Sem filtro de orientação', horizontal:'Horizontal', horizontal_sub:'Telas em paisagem', vertical:'Vertical', vertical_sub:'Telas em retrato',
        s4_label:'4 — Pré-visualizar e confirmar', preview:'Pré-visualizar', recv_title:'Dispositivos que receberão a playlist', devices:'dispositivos',
        th_device:'Dispositivo', th_city_branch:'Cidade / Sede', th_ports:'Portas', th_current:'Playlist atual', th_action:'Ação', send_all:'Enviar para todos' },
      ev: { tab:'Meus Eventos', title_my:'Meus Eventos', new_btn:'+ Novo Evento', title_new:'Novo Evento', back:'Voltar', back_list:'Meus Eventos', cancel:'Cancelar', create:'Criar Evento', delete_event:'Excluir evento', filter_all:'Todos', filter_matchmaking:'Rodadas de Negócios', new_type_label:'Tipo', new_type_std:'Evento padrão', new_type_rn:'Rodada de Negócios', new_rn_mode:'Modo de matching', new_rn_mode_auto:'Automático por interesses (tags)', new_rn_mode_manual:'Somente manual', new_rn_zone:'Zona', new_rn_zone_classic:'Clássica (uma zona)', new_rn_zone_zoned:'Zoneada',
            sub_info:'Informações', sub_form:'Formulário', sub_regs:'Inscrições', sub_staff:'Staff', sub_suppliers:'Fornecedores', sub_rundown:'Produção', sub_certs:'Certificados',
            f_name:'Nome do evento *', f_start:'Data de início *', f_end:'Data de término *', f_tz:'Fuso horário', f_capacity:'Capacidade máxima', f_desc:'Descrição', f_venue:'Local',
            card_data:'Dados do evento', c_name:'Nome', c_desc:'Descrição', c_venue:'Local', c_capacity:'Capacidade', c_start:'Data de início', c_end:'Data de término', c_tz:'Fuso horário',
            publish_cal:'Publicar no meu calendário externo',
            no_events:'Você ainda não criou eventos.',
            save:'Salvar alterações',
            f_name_ph:'Ex: Convenção SONORO 2026', f_capacity_ph:'Ex: 500', f_desc_ph:'Descrição pública do evento…', f_venue_ph:'Ex: Hotel Tequendama, Bogotá',
            inf_ticket_types:'Tipos de ingresso', inf_ticket_types_hint:'um por linha · vazio = somente "general"', inf_ticket_types_ph:'Escreva um tipo por linha, ex:\nGeneral\nVIP\nSpeaker',
            sess_card:'Sessões / Jornadas', sess_add:'+ Adicionar', sess_regmode_label:'Tipo de inscrição:',
            sess_regmode_full:'Inscrição geral (todas as sessões)', sess_regmode_per:'Multi-sessões (inscrição em sessões específicas)',
            sess_regmode_help:'Sessões privadas ou somente-convite nunca aparecem no formulário público.',
            sess_f_name:'Nome da sessão', sess_f_name_ph:'Ex: Dia 1 — Manhã',
            sess_f_speaker:'Palestrante / Speaker', sess_f_speaker_ph:'Nome do palestrante (opcional)',
            sess_f_date:'Data', sess_f_cap:'Vagas (opc.)', sess_f_cap_ph:'Sem limite',
            sess_f_start:'Hora início', sess_f_end:'Hora fim',
            sess_f_staff:'Responsável', sess_staff_none:'— Sem atribuição —',
            sess_f_obs:'Observações', sess_f_obs_ph:'Notas ou instruções especiais…',
            sess_f_visibility:'Visibilidade',
            sess_vis_public:'Pública — todos podem ver e se inscrever',
            sess_vis_private:'Privada — somente o produtor atribui manualmente',
            sess_vis_invite:'Somente convidados — requer link de convite',
            sess_save:'Salvar sessão',
            mail_card:'Configuração de e-mails',
            mail_from:'Nome do remetente', mail_from_hint:'(aparece na caixa de entrada do destinatário)', mail_from_ph:'SONORO CMS (padrão)',
            mail_reply:'Reply-To', mail_reply_hint:'(a quem o destinatário responde)', mail_reply_ph:'Vazio = sem reply-to',
            mail_note:'Os e-mails são sempre enviados de <strong>cms@sonoro.com.co</strong>. O nome do remetente e o Reply-To ficam visíveis ao destinatário. Aplica a confirmações de inscrição e e-mails de cotação a fornecedores.',
            fm_confirm_mode:'Modo de confirmação',
            fm_conf_auto:'Confirmação automática', fm_conf_auto_d:'Ao se inscrever, o passe com QR chega imediatamente',
            fm_conf_manual:'Confirmação manual', fm_conf_manual_d:'O inscrito recebe aviso de que será confirmado pela equipe. Ao confirmar no dashboard, o passe com QR é enviado',
            fx_title:'Campos fixos — sempre presentes',
            fx_fullname:'Nome completo', fx_email:'E-mail', fx_phone:'Telefone (+prefixo)', fx_doc:'Tipo + N° documento', fx_ticket:'Tipo de ingresso',
            fm_active:'Campos no formulário',
            fcat_title:'Campos disponíveis para adicionar',
            fm_new_custom:'Criar campo personalizado', fm_type_label:'Tipo:',
            fm_type_text:'Texto', fm_type_select:'Seleção', fm_type_bool:'Sim / Não', fm_type_tel:'Telefone',
            fm_save:'Salvar formulário', fm_preview:'Pré-visualização',
            fmod_title:'Novo campo',
            fmod_label_es:'Rótulo ES', fmod_label_es_ph:'Ex: Empresa',
            fmod_label_en:'Label EN', fmod_label_en_ph:'e.g. Company',
            fmod_required:'Campo obrigatório',
            fmod_opts:'Opções', fmod_opt_ph:'Nova opção…', fmod_opt_add:'+ Adicionar',
            fmod_cond:'Mostrar somente se… (opcional)',
            fmod_cond_always:'— Sempre visível —', fmod_cond_ticket:'Tipo de ingresso =',
            fmod_cond_val_ph:'ex: vip',
            fmod_add:'Adicionar ao formulário',
            reg_links:'Links do evento',
            reg_link_public:'Inscrição pública', reg_link_app:'App Check-in', reg_link_kiosko:'Totem check-in',
            reg_open:'Abrir',
            reg_search_ph:'Buscar por nome ou e-mail…',
            reg_import:'Importar CSV/XLSX', reg_template:'Modelo', reg_template_title:'Modelo XLSX com as colunas do formulário deste evento + instruções',
            reg_export_csv:'Exportar CSV', reg_export_pdf:'Exportar PDF',
            reg_print_all:'Imprimir todos', reg_print_all_title:'Imprimir etiquetas QR de todas as inscrições',
            reg_th_name:'Nome', reg_th_email:'E-mail', reg_th_type:'Tipo', reg_th_status:'Status', reg_th_date:'Inscrição',
            stf_card:'Equipe do evento', stf_add:'+ Adicionar',
            stf_new_title:'Novo membro da staff',
            stf_name:'Nome *', stf_name_ph:'Ex: Juan Pérez',
            stf_role:'Função *', stf_role_select:'— Selecionar —',
            stf_role_coord:'Coordenador', stf_role_reg:'Coordenador de Inscrições', stf_role_tech:'Coordenador Técnico',
            stf_role_host:'Coordenador de Anfitriões', stf_role_sec:'Coordenador de Segurança',
            stf_role_cat:'Coordenador de Catering', stf_role_art:'Coordenador Artístico e de Entretenimento',
            stf_role_other:'Outro',
            stf_email:'E-mail', stf_email_ph:'opcional',
            stf_phone:'Telefone', stf_phone_ph:'opcional',
            stf_pin:'PIN de acesso (check-in)', stf_pin_gen:'Gerar', stf_pin_ph:'6 dígitos — gerado automaticamente',
            stf_locale:'Idioma da staff (e-mails)',
            stf_locale_es:'Espanhol', stf_locale_en:'Inglês', stf_locale_pt:'Português (BR)',
            stf_custom:'Mensagem pessoal (opcional)', stf_custom_ph:'Ex: María, chegue às 17:45 para coordenar as credenciais VIP…',
            stf_custom_hint:'Este texto é adicionado ao e-mail de briefing como "Mensagem do produtor".',
            stf_save:'Salvar',
            stf_pool_title:'Catálogo de staff', stf_pool_hint:'Reutilizável entre eventos. Adicione aqui para não digitar os dados de novo.',
            stf_pool_search_ph:'Buscar…', stf_pool_manage:'Gerenciar catálogo →',
            sup_budget_card:'Orçamento do evento', sup_csv_title:'Baixar CSV', sup_pdf_title:'Baixar PDF', sup_budget_edit:'Editar orçamento',
            sup_budget_ph:'Orçamento total (COP)', sup_save:'Salvar',
            sup_card_budget:'Orçamento', sup_card_cot:'Total cotado', sup_card_appr:'Total aprovado', sup_card_paid:'Total pago', sup_card_bal:'Saldo disponível',
            sup_card_title_budget:'Orçamento máximo atribuído ao evento',
            sup_card_title_cot:'Soma das cotações recebidas ou aceitas',
            sup_card_title_appr:'Soma dos contratos aceitos (comprometido)',
            sup_card_title_paid:'Dinheiro já saído: adiantamentos + pagos',
            sup_card_title_bal:'Orçamento menos total aprovado (pode ser negativo)',
            sup_contracts:'Fornecedores', sup_contract_add:'+ Adicionar',
            sup_c_supplier:'Fornecedor do diretório *', sup_c_supplier_sel:'— Selecione o fornecedor —',
            sup_c_role:'Descrição do serviço', sup_c_role_ph:'Ex: Som principal, Cobertura fotográfica',
            sup_c_amount:'Orçamento aproximado (COP)',
            sup_c_notes:'Notas', sup_c_notes_ph:'Observações',
            sup_dir:'Diretório de fornecedores', sup_dir_new:'+ Novo',
            sup_d_name:'Nome *', sup_d_name_ph:'Nome da empresa ou pessoa',
            sup_d_cat:'Categoria', sup_d_cat_ph:'Ex: Som, Fotografia, Catering',
            sup_d_contact:'Contato', sup_d_contact_ph:'Nome do contato',
            sup_d_phone:'Telefone', sup_d_phone_ph:'+57 300 0000000',
            sup_d_email:'E-mail', sup_d_email_ph:'fornecedor@exemplo.com',
            sup_d_id_type:'Tipo ID', sup_d_id_num:'N° identificação', sup_d_id_num_ph:'900.123.456-7',
            sup_d_locale:'Idioma do fornecedor (e-mails)',
            sup_d_docs:'Documentos legais', sup_d_doc_rut:'RUT', sup_d_doc_cert:'Cert. bancário', sup_d_doc_camara:'Câmara comércio',
            prod_dash_title:'Dashboard de produção', prod_dash_tag:'Produtor',
            prod_dash_desc:'Monitor de controle ao vivo: stats, cronômetro, sessões e canal para telas. Tela principal do produtor geral.',
            prod_open_newtab:'Abrir em nova aba', prod_copy_url:'Copiar URL', prod_revoke:'Revogar token', prod_gen_url:'Gerar URL pública',
            prod_tp_title:'Teleprompter', prod_tp_tag:'Palestrante',
            prod_tp_desc:'Vista limpa para o monitor de confidence do palestrante: nome da sessão, timer gigante, o que vem depois. URL diferente por sessão.',
            prod_tp_session:'Sessão:', prod_tp_nosess:'Sem sessões',
            prod_tp_open:'Abrir', prod_tp_copy:'Copiar', prod_tp_wa:'WhatsApp', prod_tp_revoke:'Revogar',
            prod_tp_gen:'Gerar URL para esta sessão',
            prod_libreto:'Roteiro do evento', prod_cue_add:'+ Adicionar cue',
            prod_cue_num:'Nº', prod_cue_num_ph:'01',
            prod_cue_title_lbl:'Título *', prod_cue_title_ph:'Abertura do evento',
            prod_cue_sched:'Horário programado *',
            prod_cue_dur:'Duração (min)', prod_cue_dur_ph:'30',
            prod_cue_zone:'Zona / Espaço', prod_cue_zone_ph:'Auditório principal',
            prod_cue_resp:'Responsável',
            prod_cue_notes:'Notas técnicas', prod_cue_notes_ph:'Áudio: mic sem fio. Vídeo: slide 1…',
            prod_th_num:'Nº', prod_th_time:'Hora', prod_th_title:'Título', prod_th_dur:'Dur.', prod_th_zone:'Zona', prod_th_status:'Status',
            cert_intro_title:'Certificados do evento',
            cert_intro_desc:'Desenhe seu certificado como uma imagem de fundo (canvas). O sistema apenas sobrepõe os dados dinâmicos: nome, evento, sessão, horas, data e QR de verificação.',
            cert_guide:'Abrir guia de design',
            cert_tpls:'Modelos', cert_tpl_new:'Novo modelo',
            cert_issued:'Emitidos', cert_search_ph:'Buscar…', cert_bulk:'Emissão em massa',
            cert_th_att:'Participante', cert_th_tpl:'Modelo', cert_th_hours:'Horas', cert_th_issued:'Emitido', cert_th_status:'Status',
            manage:'Gerenciar', publish:'Publicar', unpublish:'Despublicar',
            unpublish_confirm:'Despublicar o evento? A página pública deixará de ser acessível.',
            list_loading:'Carregando eventos…', list_empty_title:'Sem eventos ainda', list_empty_sub:'Crie seu primeiro evento para começar.', list_error:'Erro ao carregar eventos.',
            panel: { title:'Painel resumo', sub_default:'Visão agregada dos seus eventos · últimos 12 meses', sub_30d:'Visão agregada · últimos 30 dias', sub_90d:'Visão agregada · últimos 90 dias', sub_12m:'Visão agregada · últimos 12 meses', sub_ytd:'Visão agregada · ano até hoje', sub_all:'Visão agregada · histórico completo', r_ytd:'YTD', r_all:'Tudo', collapse:'Recolher / expandir', k_events:'Eventos realizados', k_done:'Realizados', k_sched:'Programados', k_cancel:'Cancelados', k_done_sub:'de 0 totais', k_done_sub_tpl:'de {total} totais', k_att:'Participantes', k_att_sub:'compareceram (de 0)', k_att_sub_tpl:'compareceram (de {reg})', k_checkin:'Check-in', k_noshow:'No show', k_proj:'Orçamento projetado', k_total:'Total', k_avg:'Média por evento', k_paid:'Orçamento pago', k_paid_sub:'pago a fornecedores', k_paid_lbl:'Pago', k_pending:'Pendente', events_word:'eventos', top5_title:'Top eventos por público', top5_empty:'Sem eventos realizados no período.', monthly_title:'Eventos por mês', day:'dia', days:'dias', attendees_short:'part', tier_badge:'Pro · Masivo', teaser_title:'Painel resumo', teaser_body:'Veja métricas agregadas de todos os seus eventos: participantes, orçamento projetado vs executado, top eventos e evolução mensal. Exporte relatórios em PDF e Excel.', teaser_cta:'Ver planos', export_err:'Não foi possível gerar o relatório.' },
            sess_edit:'Editar', sess_loading:'Carregando…', sess_empty:'Sem sessões. Adicione uma acima.', sess_error:'Erro ao carregar sessões.',
            sess_cap_word:'vagas', sess_vis_private_badge:'PRIVADA', sess_vis_invite_badge:'SOMENTE CONVIDADOS',
            fm_empty:'Nenhum campo adicionado ainda.', fcat_all_added:'Todos os campos disponíveis já estão no formulário.',
            fcat_add:'+ Adicionar ao formulário', fcat_cond:'COND.', fcat_remove:'Remover', fcat_required:'obrigatório', fcat_only_if:'somente se',
            fcat_organization:'Empresa / Instituição', fcat_job_title:'Cargo', fcat_dietary:'Restrição alimentar', fcat_tshirt_size:'Tamanho de camiseta',
            fcat_emergency:'Contato de emergência', fcat_emergency_ph:'Tel. emergência', fcat_eps:'Plano de saúde', fcat_blood_type:'Tipo sanguíneo',
            fcat_transport:'Deseja ofertas de transporte e hospedagem?', fcat_tourism:'Deseja informações turísticas e planos complementares?',
            fcat_attended:'Já participou de eventos anteriores?',
            reg_cancel:'Cancelar', reg_confirm:'Confirmar', reg_edit:'Editar',
            reg_assign_session:'Atribuir sessão', reg_cert:'Certificado', reg_delete:'Excluir',
            reg_status_confirmed:'Confirmado', reg_status_cancelled:'Cancelado', reg_status_pending:'Pendente',
            reg_no_results:'Sem inscrições.', reg_error:'Erro ao carregar inscrições.',
            reg_extra_tel:'Tel:', reg_extra_id:'ID:', reg_extra_company:'Empresa:', reg_extra_role:'Cargo:',
            reg_no_extra:'Sem dados adicionais', reg_sessions_label:'Sessões:', reg_checkins:'Check-ins',
            reg_checkin_general:'Entrada geral', reg_checkin_session:'Sessão', reg_no_checkins:'Sem check-ins registrados',
            reg_certs:'Certificados', reg_edit_title:'Editar dados do inscrito', reg_print_title:'Imprimir etiqueta QR',
            reg_assign_title:'Atribuir ou remover sessões (inclui privadas)', reg_cert_title:'Emitir / gerenciar certificado',
            regs_stat_of:'de', regs_stat_seats_word:'vagas', regs_stat_no_limit:'sem limite de vagas',
            regs_stat_registered:'Inscritos', regs_stat_confirmed:'Confirmados', regs_stat_of_registered:'inscritos',
            regs_stat_pending:'Pendentes', regs_stat_pending_sub:'pendentes de confirmação',
            regs_chart_title:'Check-ins por sessão',
            stf_add_to_event:'+ Adicionar ao evento',
            stf_pool_empty:'Catálogo vazio. Crie staff reutilizável na aba Staff da barra lateral.',
            stf_pool_no_results:'Sem resultados.', stf_pool_loading:'Carregando…', stf_pool_error:'Erro ao carregar catálogo.',
            stf_send_briefing:'Enviar briefing', stf_briefing_sent:'Briefing enviado em',
            stf_briefing_title:'Enviar briefing por e-mail', stf_pin_title:'PIN de check-in',
            sup_budget_undefined:'Não definido', sup_edit:'Editar',
            sup_contracts_empty:'Sem fornecedores ainda.',
            sup_dir_empty:'Diretório vazio. Adicione fornecedores frequentes para reutilizá-los em eventos futuros.',
            sup_deposit:'Entrada:', sup_deposit_of:'de', sup_view_quote:'Ver cotação', sup_waiting_resp:'Aguardando resp.',
            sup_request_quote:'Solicitar cotação', sup_see_proof:'Ver comprovante', sup_upload_proof:'Enviar comprovante',
            sup_abono_q:'Quanto foi a entrada?', sup_abono_ph:'Valor adiantado (COP)', sup_abono_confirm:'Confirmar', sup_cancel:'Cancelar',
            sup_hist_accepted:'Aceita', sup_hist_partial:'Entrada', sup_hist_paid:'Pagamento completo', sup_hist_rejected:'Rejeitada', sup_hist_cancelled:'Cancelada',
            cert_edit:'Editar', cert_preview:'Pré-visualização', cert_delete:'Excluir', cert_resend:'Reenviar', cert_revoke:'Revogar',
            cert_tpl_empty:'Ainda não há modelos. Crie um para começar a emitir certificados.',
            cert_issued_empty:'Ainda não há certificados emitidos.',
            cert_reg_empty:'Este participante ainda não tem certificados emitidos.',
            cert_tpl_scope_session:'Sessão específica', cert_tpl_scope_event:'Evento completo',
            cert_tpl_page_half:'Meia carta', cert_tpl_page_letter:'Carta',
            cert_tpl_active:'Ativa', cert_tpl_inactive:'Inativa',
            cert_tpl_canvas_ok:'Canvas carregado', cert_tpl_canvas_missing:'Sem canvas',
            cert_tpl_issued_count:'emitidos', cert_tpl_edit:'Editar modelo', cert_tpl_new:'Novo modelo',
            cert_state_revoked:'Revogado', cert_state_sent:'Enviado', cert_state_issued:'Emitido',
            prod_cue_empty:'Sem cues. Adicione o primeiro com o botão acima.',
            prod_status_pending:'Pendente', prod_status_in_progress:'Em andamento', prod_status_done:'Finalizado',
            prod_status_skipped:'Omitido', prod_status_delayed:'Com atraso', prod_cue_edit:'Editar',
            toast_ev_created:'Evento criado', toast_ev_updated:'Evento atualizado', toast_ev_deleted:'Evento excluído',
            toast_ev_published:'Evento publicado — a página pública está ativa', toast_ev_unpublished:'Evento despublicado',
            toast_sess_added:'Sessão adicionada', toast_sess_updated:'Sessão atualizada', toast_sess_deleted:'Sessão excluída', toast_sess_updated_bulk:'Sessões atualizadas',
            toast_form_saved:'Formulário salvo',
            toast_staff_added:'Staff adicionado', toast_staff_created:'Staff criado', toast_staff_updated:'Staff atualizado', toast_staff_deleted:'Staff excluído',
            toast_briefing_sent:'Briefing enviado para {name}',
            toast_sup_added:'Fornecedor adicionado', toast_sup_created:'Fornecedor criado', toast_sup_updated:'Fornecedor atualizado', toast_sup_saved_dir:'Fornecedor salvo no diretório',
            toast_sup_removed_ev:'Fornecedor removido do evento', toast_sup_removed_dir:'Fornecedor removido do diretório',
            toast_budget_saved:'Orçamento salvo', toast_price_updated:'Preço atualizado',
            toast_quote_sent:'Cotação enviada para {email}',
            toast_doc_saved:'Documento salvo', toast_receipt_saved:'Comprovante salvo',
            toast_cue_added:'Cue adicionado', toast_cue_updated:'Cue atualizado', toast_cue_deleted:'Cue excluído',
            toast_cert_tpl_created:'Modelo criado', toast_cert_tpl_updated:'Modelo atualizado', toast_cert_tpl_deleted:'Modelo excluído', toast_cert_revoked:'Certificado revogado',
            toast_mail_resent:'E-mail reenviado', toast_qr_resent:'QR reenviado para {email}',
            toast_reg_updated:'Inscrito atualizado', toast_reg_deleted:'Registro excluído',
            toast_url_generated:'URL pública gerada', toast_url_copied:'URL copiada', toast_link_copied:'Link copiado', toast_staff_link_copied:'Link copiado — válido por 24h. Envie para o staff.',
            toast_cal_disconnected:'Calendário desconectado',
            confirm_ev_del:'Excluir "{name}"?\n\nEsta ação é irreversível: todos os registros, check-ins e dados do evento serão apagados.',
            confirm_sess_del:'Excluir esta sessão?',
            confirm_reg_del:'Excluir permanentemente este registro? Esta ação não pode ser desfeita.',
            confirm_qr_resend:'Reenviar e-mail com o QR para o inscrito?',
            confirm_staff_remove:'Excluir "{name}" do staff?',
            confirm_staff_pool_remove:'Remover "{name}" deste evento?',
            confirm_staff_cat_del:'Excluir "{name}" do catálogo? As atribuições a eventos passados são mantidas.',
            confirm_sup_del_dir:'Excluir "{name}" do diretório? Esta ação não pode ser desfeita.',
            confirm_sup_dir_del:'Excluir "{name}" do diretório?',
            confirm_cal_disc:'Desconectar este calendário?',
            confirm_cert_tpl_del:'Excluir este modelo? Se já tiver certificados emitidos, será marcado como inativo.',
            confirm_token_revoke:'Revogar este token? A URL atual deixará de funcionar.',
            confirm_quote_send:'Enviar o formulário de cotação para {email}?',
            confirm_price_update:'Atualizar o valor contratado para {amount}?',
            confirm_cue_del:'Excluir este cue?',
            confirm_contract_accepted:'Aceitar esta cotação? Será registrada como aprovada no histórico.',
            confirm_contract_rejected:'Marcar como rejeitada? O fornecedor sairá do orçamento.',
            confirm_contract_paid:'Confirmar pagamento integral? Será registrado no histórico.',
            confirm_contract_cancelled:'Cancelar este contrato? A ação será registrada.',
            err_generic:'Erro', err_network:'Erro de conexão', err_save:'Erro ao salvar', err_delete:'Erro ao excluir', err_load:'Erro ao carregar', err_send:'Erro ao enviar', err_add:'Erro ao adicionar',
            err_name_required:'Nome obrigatório', err_role_required:'Selecione uma função', err_role_before_send:'Selecione uma função antes de enviar', err_session_required:'Selecione a sessão', err_tpl_required:'Selecione um modelo', err_valid_amount:'Informe um valor válido', err_valid_value:'Informe um valor válido', err_open_event_first:'Abra um evento primeiro', err_name_dates_required:'Nome, data e horários são obrigatórios', err_name_dates_short:'Nome e datas são obrigatórios', err_title_time_required:'Título e horário são obrigatórios',
            err_create_event:'Erro ao criar evento', err_load_event:'Erro ao carregar evento', err_load_staff:'Erro ao carregar staff', err_load_sup:'Erro ao carregar fornecedores', err_load_invitations:'Erro ao carregar convites', err_load_quote:'Erro ao carregar cotação',
            err_generate_link:'Erro ao gerar link', err_generate_token:'Erro ao gerar token', err_generate_preview:'Erro ao gerar prévia', err_generate_pdf:'Erro ao gerar PDF', err_generate_csv:'Erro ao gerar CSV', err_generate_tpl:'Erro ao gerar modelo', err_dl_tpl:'Erro ao baixar modelo', err_export_csv:'Erro ao exportar CSV', err_import:'Erro ao importar arquivo',
            err_disconnect:'Erro ao desconectar', err_revoke:'Erro ao revogar', err_resend:'Erro ao reenviar', err_popup_blocked:'Permita pop-ups para imprimir', err_print_prep:'Erro ao preparar impressão',
            err_send_quote:'Erro ao enviar cotação', err_update_price:'Erro ao atualizar preço', err_update_status:'Erro ao atualizar status', err_del_event:'Erro ao excluir evento', err_upload_doc:'Erro ao enviar documento', err_upload_receipt:'Erro ao enviar comprovante', err_save_budget:'Erro ao salvar orçamento', err_save_cue:'Erro ao salvar cue', err_del_cue:'Erro ao excluir cue',
            err_briefing:'Erro ao enviar briefing', err_staff_notfound:'Staff não encontrado', err_staff_noemail:'Este staff não tem e-mail', err_add_sup_dir_first:'Primeiro adicione fornecedores ao diretório', err_select_sup:'Selecione um fornecedor do diretório', err_no_quote:'Sem cotação', err_first_create_tpl:'Primeiro crie um modelo', err_save_resend:'Salvo, mas erro ao reenviar: {msg}' },
      toast: { language_updated:'Idioma atualizado' },
      rn: {
        hdr: { panel:'Painel do produtor', link:'Link', link_title:'Copiar link público', back:'Meus Eventos', status_published:'Publicada', status_draft:'Rascunho', status_live:'Ao vivo', status_closed:'Encerrada', status_archived:'Arquivada', sub_mode:'modo', sub_zone:'zona' },
        donut: { complete_k:'Prontas para o match', complete:'Completas', incomplete:'Incompletas', mix_k:'Mix de empresas', offer:'Oferece', demand:'Busca', both:'Ambos', util_k:'Utilização de slots', booked:'Agendados', free:'Livres' },
        kpi: { regs:'Empresas inscritas', complete:'Com interesses completos', requests:'Solicitações diretas', util:'Utilização prevista' },
        subtab: { setup:'Setup', tags:'Tags', dir:'Diretório', agenda:'Agenda', live:'Live', rep:'Relatório' },
        toast: { saving:'Salvando…', saved_prefix:'Salvo · ', save_err:'Erro ao salvar', net_err:'Erro de conexão', send_ok:'Relatório enviado', send_err:'Erro ao enviar relatório', send_err_cover:'Cobertura EBV < 20%. Confirme para enviar mesmo assim.' },
        empty: { rounds_planned:'Sem rodadas planejadas', tables:'Sem mesas configuradas', registered:'Sem inscritos', rounds_see_agenda:'Sem rodadas planejadas (veja Agenda)', meetings_open_round:'Sem reuniões — abra uma rodada', tags_empty:'Sem tags · importe Excel ou crie a primeira', catalog_err_prefix:'Erro ao carregar catálogo', rows:'Sem linhas', meetings_ebv:'Sem reuniões com EBV capturado', loading:'Carregando…', report_err:'Não foi possível carregar o relatório' },
        setup: {
          c1_title:'01 · Informações básicas', c1_name:'Nome', c1_public_url:'URL pública:', c1_starts:'Início', c1_ends:'Fim', c1_tz:'Fuso horário', c1_currency:'Moeda base (EBV)', c1_deflocale:'Idioma padrão', c1_deflocale_hint:'Idioma dos e-mails quando o delegado não escolheu.', c1_venue:'Local', c1_venue_ph:'Hotel, centro de convenções…',
          c2_title:'02 · Modo de operação', c2_classic:'Classic', c2_classic_hint:'Um único piso de mesas', c2_zoned:'Zoned', c2_zoned_hint:'Mesas agrupadas em zonas',
          c3_title:'03 · Matching', c3_tags:'Por interesses (tags)', c3_tags_hint:'Solver propõe reuniões por overlap de interesses', c3_manual:'Somente manual', c3_manual_hint:'Todas as reuniões são escolhidas pelos participantes', c3_dirview:'Vista padrão do diretório', c3_dirview_match:'Apenas com match', c3_dirview_all:'Todos os participantes',
          c4_title:'04 · Visibilidade', c4_public:'Pública', c4_public_hint:'Inscrição aberta', c4_mixed:'Mista', c4_mixed_hint:'Pública + convites', c4_private:'Privada', c4_private_hint:'Somente convidados',
          c5_title:'05 · Horários', c5_dur:'Duração por reunião', c5_noshow:'Política de no-show', c5_noshow_none:'Sem bloqueio', c5_buffer:'Buffer entre rodadas', c5_buffer_none:'Sem buffer', c5_autoadv:'Avançar automaticamente de rodada',
          c6_title:'06 · Opções', c6_langs:'Idiomas aceitos', c6_twodel:'Permitir dois participantes por empresa', c6_ebv:'Capturar valor estimado de negócio (EBV)', c6_team:'Permitir convidar equipe',
          discard:'Descartar alterações', save:'Salvar configuração'
        },
        tags: {
          catalog:'Meu catálogo', count_suffix:'tags · reutilizado em todas as suas rodadas',
          btn_template:'Modelo', btn_export:'Exportar', btn_import:'Importar Excel', btn_new:'+ Nova tag',
          info_title:'O que é o catálogo de tags?',
          info_p1:'As tags são as categorias de oferta (o que uma empresa vende) e demanda (o que busca comprar) que o participante marca ao se inscrever. O motor da Rueda só faz match entre empresas usando as tags deste catálogo — por isso ele precisa estar pronto antes de abrir inscrições.',
          info_p2:'Primeira rodada? Baixe um modelo Excel com 2 colunas (Nome, Categoria), preencha com as tags do seu setor e envie aqui.',
          col_name:'Nome', col_id:'Identificador', col_id_title:'Versão normalizada do nome, gerada automaticamente', col_cat:'Categoria', col_actions:'Ações', loading:'Carregando…',
          new_title:'Nova tag', new_name:'Nome', new_name_ph:'Ex. Software sob medida', new_name_hint:'É o que o participante verá ao escolher suas tags. Use 1 a 5 palavras.',
          new_fuzzy_title:'Você quis dizer alguma destas?', new_fuzzy_hint:'Se nenhuma se aplica, continue com sua tag. Evitar duplicadas melhora o match.',
          new_cat:'Categoria (opcional)', new_cat_ph:'Ex. Tecnologia', new_cat_hint:'Agrupa tags relacionadas no formulário do participante (ex. Logística, Tecnologia, Agro).',
          new_create:'Criar tag',
          edit_title:'Editar tag', save_changes:'Salvar alterações',
          bulk_title:'Pré-visualização · importar catálogo', bulk_det:'Detectados', bulk_new:'Novos', bulk_sim:'Similares', bulk_dup:'Duplicados',
          bulk_hint:'Revise cada linha e decida. Nada é salvo até confirmar.', bulk_confirm:'Confirmar',
          bulk_confirm_fmt_one:'Confirmar e criar 1 tag', bulk_confirm_fmt_many:'Confirmar e criar {n} tags'
        },
        dir: { title:'Participantes inscritos', search_ph:'Buscar empresa, nome, tag…', col_company:'Empresa', col_contact:'Contato', col_offer:'Oferece', col_demand:'Busca', col_req:'Req. in/out', col_status:'Status' },
        agenda: {
          plan_title:'Planejar rodadas', plan_starts:'Início', plan_total:'Rodadas', plan_breakev:'Pausa a cada N', plan_gen:'Gerar',
          tables_title:'Mesas', tables_add:'+ Adicionar',
          solver_title:'Solver', solver_preview:'Preview', solver_run:'Rodar solver', solver_reset:'Reset',
          meetings_title:'Reuniões', meetings_refresh:'Atualizar', col_round:'Rodada', col_table:'Mesa', col_a:'Empresa A', col_b:'Empresa B', col_origin:'Origem', col_lock:'Lock'
        },
        live: {
          callboard:'Callboard do produtor', checkins_suffix:'check-ins', active:'Rodada ativa', active_prefix:'Rodada ativa: ', no_active:'Nenhuma rodada aberta',
          rounds:'Rodadas programadas', meetings:'Reuniões ao vivo',
          col_table:'Mesa', col_a:'Empresa A', col_b:'Empresa B', col_origin:'Origem', col_status:'Status',
          empty:'Sem reuniões — abra uma rodada'
        },
        rep: {
          title:'Relatório pós-evento', send:'Enviar relatório por e-mail',
          banner_ref:'Dado referencial · cobertura EBV < 20%. Interprete com cautela.',
          banner_fx:'Várias moedas detectadas · v1 assume COP, totais são aproximados.',
          kpi_total:'Reuniões totais', kpi_ebv:'Com EBV', kpi_avg:'EBV médio / reunião', kpi_sum:'EBV total estimado',
          dist:'Distribuição EBV', median:'Mediana', min:'Mínimo', max:'Máximo', bilat:'Bilateral', unilat:'Unilateral', empty:'Sem EBV',
          top:'Top reuniões por valor esperado',
          col_n:'#', col_a:'Empresa A', col_b:'Empresa B', col_round_table:'Rodada · Mesa', col_type:'Tipo', col_horizon:'Horizonte', col_value:'Valor',
          empty_table:'Sem dados — carregue o relatório',
          cov_suffix:'% cobertura', sending:'Enviando…'
        }
      }
    }
  };
  var SUPPORTED = ['es','en','pt-BR'];
  var state = { locale:'es', dict: LOCALES.es };

  function detectFromNavigator(){
    var n = (navigator.language||'').toLowerCase();
    if (n.indexOf('pt')===0) return 'pt-BR';
    if (n.indexOf('en')===0) return 'en';
    return 'es';
  }
  function resolveLocale(raw){
    if (!raw) return 'es';
    if (SUPPORTED.indexOf(raw)>=0) return raw;
    var s = raw.split('-')[0].toLowerCase();
    if (s==='pt') return 'pt-BR';
    if (s==='en') return 'en';
    return 'es';
  }
  function getByPath(o,p){ return p.split('.').reduce(function(a,k){ return (a && a[k]!=null ? a[k] : undefined); }, o); }
  function t(key, fallback){
    var v = getByPath(state.dict, key);
    return typeof v === 'string' ? v : (fallback != null ? fallback : key);
  }
  function applyI18n(root){
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function(el){
      var key = el.getAttribute('data-i18n');
      var val = t(key, el.textContent);
      if (val.indexOf('<')>=0) el.innerHTML = val; else el.textContent = val;
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(function(el){
      var spec = el.getAttribute('data-i18n-attr');
      spec.split(',').forEach(function(pair){
        var parts = pair.split(':').map(function(s){return s.trim();});
        var attr = parts[0], key = parts[1];
        if (attr && key) el.setAttribute(attr, t(key, el.getAttribute(attr)));
      });
    });
    document.documentElement.setAttribute('lang', state.locale);
  }
  function showToastMini(msg){
    var box = document.getElementById('sonoroI18nToast');
    if (!box){
      box = document.createElement('div');
      box.id = 'sonoroI18nToast';
      box.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--online,#00c896);color:#000;padding:10px 18px;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:.5px;z-index:10001;opacity:0;transition:opacity .2s;font-family:Montserrat,sans-serif;';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(box._t);
    box._t = setTimeout(function(){ box.style.opacity='0'; }, 1800);
  }
  function persistLocaleRemote(locale){
    try {
      var tk = localStorage.getItem('authToken');
      if (!tk) return;
      fetch('/api/user/locale', {
        method:'PATCH',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+tk },
        body: JSON.stringify({ locale: locale })
      }).catch(function(){});
    } catch(e){}
  }
  function baseSetLocale(locale){
    var r = resolveLocale(locale);
    state.locale = r;
    state.dict = LOCALES[r];
    try { localStorage.setItem('sonoro_locale', r); } catch(e){}
    applyI18n(document);
    var selectors = ['sonoroLangSelect','langSelect','langSelectDash','langSelectLogin'];
    selectors.forEach(function(id){ var el = document.getElementById(id); if (el) el.value = r; });
    showToastMini(t('toast.language_updated'));
    persistLocaleRemote(r);
  }
  window.SonoroI18n = { t:t, applyI18n:applyI18n, setLocale:baseSetLocale, getLocale:function(){ return state.locale; } };

  // ---------------- Dynamic re-renderers (guarded monkey-patches) ----------------

  var LIC_DYN = {
    es: { prod:{smart_tv:'Licencia SONORO Smart TV', player:'Licencia SONORO Player', windows:'Licencia SONORO Windows', dashboard_admin:'Licencia Dashboard Admin'},
          badge:{active:'Activa', trial:'Prueba', expired:'Vencida', paid:'Pagada', pending:'Pendiente pago', proof:'Comprobante enviado', cancelled:'Cancelada'},
          days:'días', expires:'Vence', renew:'Renovar', no_device:'Sin dispositivo asignado', device_hash:'Dispositivo', no_lic:'Aún no tienes licencias activas.', no_orders:'Sin órdenes aún.', upload_proof:'Subir comprobante', replace_proof:'Reemplazar comprobante' },
    en: { prod:{smart_tv:'SONORO Smart TV License', player:'SONORO Player License', windows:'SONORO Windows License', dashboard_admin:'Admin Dashboard License'},
          badge:{active:'Active', trial:'Trial', expired:'Expired', paid:'Paid', pending:'Payment pending', proof:'Proof uploaded', cancelled:'Cancelled'},
          days:'days', expires:'Expires', renew:'Renew', no_device:'No device assigned', device_hash:'Device', no_lic:'You have no active licenses yet.', no_orders:'No orders yet.', upload_proof:'Upload proof', replace_proof:'Replace proof' },
    'pt-BR': { prod:{smart_tv:'Licença SONORO Smart TV', player:'Licença SONORO Player', windows:'Licença SONORO Windows', dashboard_admin:'Licença Dashboard Admin'},
          badge:{active:'Ativa', trial:'Teste', expired:'Vencida', paid:'Paga', pending:'Pagamento pendente', proof:'Comprovante enviado', cancelled:'Cancelada'},
          days:'dias', expires:'Vence', renew:'Renovar', no_device:'Sem dispositivo atribuído', device_hash:'Dispositivo', no_lic:'Você ainda não tem licenças ativas.', no_orders:'Sem pedidos ainda.', upload_proof:'Enviar comprovante', replace_proof:'Substituir comprovante' }
  };
  function ld(){ return LIC_DYN[state.locale] || LIC_DYN.es; }

  function patchLicRenders(){
    if (typeof window.renderLicActiveGrid !== 'function' || window.renderLicActiveGrid._sonoroPatched) return;
    var origActive = window.renderLicActiveGrid;
    window.renderLicActiveGrid = function(licenses){
      var el = document.getElementById('licActiveGrid'); if (!el) return;
      var L = ld();
      if (!licenses || !licenses.length){ el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">'+L.no_lic+'</div>'; return; }
      el.innerHTML = licenses.map(function(l){
        var prod = L.prod[l.product] || l.product_label || l.product;
        var isTrial = l.is_trial === true || l.status === 'trial';
        var status = l.status || 'active';
        var badgeClass = isTrial ? 'trial' : status;
        var badgeLabel = isTrial ? L.badge.trial : (status === 'expired' ? L.badge.expired : L.badge.active);
        var dLeft = (typeof licDaysLeft==='function') ? licDaysLeft(l.end_date) : null;
        var daysTxt = dLeft === null ? '—' : (dLeft < 0 ? L.badge.expired : (dLeft+' '+L.days));
        var esc = (typeof licEsc==='function') ? licEsc : function(x){ return x==null?'':String(x); };
        var dt = (typeof licDate==='function') ? licDate : function(x){ return x||'—'; };
        var devLabel = l.device_name ? esc(l.device_name) : (l.device_id ? (L.device_hash+' #'+l.device_id) : L.no_device);
        return '<div class="lic-card">'+
          '<div class="lic-prod">'+esc(prod)+'</div>'+
          '<div class="lic-device">'+devLabel+'</div>'+
          '<span class="lic-badge '+badgeClass+'">'+badgeLabel+'</span>'+
          '<div class="lic-days">'+L.expires+': <strong>'+dt(l.end_date)+'</strong> · <strong>'+daysTxt+'</strong></div>'+
          '<button class="lic-btn-outline" onclick="openLicNewOrder(\''+esc(l.product)+'\')">'+L.renew+'</button>'+
          '</div>';
      }).join('');
    };
    window.renderLicActiveGrid._sonoroPatched = true;
    if (typeof window.renderLicOrders === 'function' && !window.renderLicOrders._sonoroPatched){
      window.renderLicOrders = function(orders){
        var el = document.getElementById('licOrdersBody'); if (!el) return;
        var L = ld();
        var esc = (typeof licEsc==='function') ? licEsc : function(x){ return x==null?'':String(x); };
        var dt = (typeof licDate==='function') ? licDate : function(x){ return x||'—'; };
        var money = (typeof licMoney==='function') ? licMoney : function(a,c){ return a+' '+(c||''); };
        if (!orders || !orders.length){ el.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:20px;">'+L.no_orders+'</td></tr>'; return; }
        el.innerHTML = orders.map(function(o){
          var prod = L.prod[o.product] || o.product;
          var st = o.status || 'pending';
          var badge = st === 'paid' ? '<span class="lic-badge active">'+L.badge.paid+'</span>'
            : st === 'proof_uploaded' ? '<span class="lic-badge pending">'+L.badge.proof+'</span>'
            : st === 'cancelled' ? '<span class="lic-badge expired">'+L.badge.cancelled+'</span>'
            : '<span class="lic-badge pending">'+L.badge.pending+'</span>';
          var action = '—';
          if (st === 'pending_payment' || st === 'proof_uploaded' || st === 'pending'){
            var label = st === 'proof_uploaded' ? L.replace_proof : L.upload_proof;
            action = '<label class="lic-btn-outline" style="cursor:pointer;">'+label+'<input type="file" style="display:none;" accept="image/*,.pdf" onchange="licUploadProof('+o.id+', this.files[0])"></label>';
          }
          return '<tr><td>#'+esc(o.id)+'</td><td>'+esc(prod)+'</td><td class="right">'+money(o.amount, o.currency)+'</td><td>'+badge+'</td><td>'+dt(o.created_at)+'</td><td class="right">'+action+'</td></tr>';
        }).join('');
      };
      window.renderLicOrders._sonoroPatched = true;
    }
  }

  var CNT_DYN = {
    es: { no_files:'No hay archivos', video:'video', image:'image', optimizing:'Optimizando para RPi5' },
    en: { no_files:'No files',        video:'video', image:'image', optimizing:'Optimizing for RPi5' },
    'pt-BR': { no_files:'Sem arquivos', video:'video', image:'image', optimizing:'Otimizando para RPi5' }
  };
  function patchContentRenders(){
    if (typeof window.displayFiles !== 'function' || window.displayFiles._sonoroPatched) return;
    window.displayFiles = function(files){
      var el = document.getElementById('fileList'); if (!el) return;
      var L = CNT_DYN[state.locale] || CNT_DYN.es;
      if (!files || !files.length){ el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">'+L.no_files+'</p>'; return; }
      var esc = (typeof window.escOnclick === 'function') ? window.escOnclick : function(s){ return String(s||'').replace(/'/g,"\'"); };
      el.innerHTML = files.map(function(file){
        var size = ((file.size_bytes||file.size||0)/1024/1024).toFixed(2);
        var dur = (file.duration_ms || file.duration) ? '<small>'+(((file.duration_ms||file.duration*1000))/1000).toFixed(1)+'s</small>' : '';
        var processing = file.hevc_status === 'pending' || file.hevc_status === 'processing' || file.hevc_status === 'uploading';
        var title = file.title || file.name || file.filename || '';
        var fp = file.file_path || '';
        return '<div class="file-item" data-content-id="'+file.id+'">'+
          '<div class="file-info">'+
          '<strong>'+title+'</strong>'+
          '<span class="file-type-badge '+(file.type==='image'?'badge-image':'badge-video')+'">'+(file.type==='image'?L.image:L.video)+'</span>'+
          '<small>'+size+' MB</small>'+dur+
          '<div class="hevc-progress" id="hevc-progress-'+file.id+'" style="display:'+(processing?'block':'none')+'">'+
            '<div class="hevc-progress-label">'+L.optimizing+'<span id="hevc-percent-'+file.id+'"></span></div>'+
            '<div class="hevc-progress-track"><div class="hevc-progress-fill" id="hevc-fill-'+file.id+'" style="width:0%"></div></div>'+
          '</div>'+
          '</div>'+
          '<button class="btn btn-outline btn-sm" onclick="playFile(\''+fp+'\',\''+esc(title)+'\',\''+file.type+'\')">▶</button>'+
          '<button class="btn btn-danger btn-sm" onclick="deleteFile('+file.id+')">✕</button>'+
          '</div>';
      }).join('');
    };
    window.displayFiles._sonoroPatched = true;
  }

  var PL_DYN = {
    es: { no_playlists:'No hay listas', items:'elementos', vertical:'Vertical', horizontal:'Horizontal', shuffle:'Aleatorio', repeat:'Repetir', edit:'✏ Editar' },
    en: { no_playlists:'No playlists',  items:'items',     vertical:'Vertical', horizontal:'Horizontal', shuffle:'Shuffle',    repeat:'Repeat',  edit:'✏ Edit' },
    'pt-BR': { no_playlists:'Sem playlists', items:'itens', vertical:'Vertical', horizontal:'Horizontal', shuffle:'Aleatório', repeat:'Repetir', edit:'✏ Editar' }
  };
  function patchPlaylistsRender(){
    if (typeof window.loadPlaylists !== 'function' || window.loadPlaylists._sonoroPatched) return;
    window.loadPlaylists = async function(){
      var container = document.getElementById('playlistsList'); if (!container) return;
      var L = PL_DYN[state.locale] || PL_DYN.es;
      try {
        var res = await fetch((window.API_URL||'')+'/api/playlists', { headers:{ 'Authorization':'Bearer '+(window.authToken||localStorage.getItem('authToken')||'') } });
        var playlists = await res.json();
        if (!Array.isArray(playlists)) playlists = playlists.playlists || [];
        if (!playlists.length){ container.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">'+L.no_playlists+'</p>'; return; }
        container.innerHTML = playlists.map(function(pl){
          var count = pl.item_count != null ? pl.item_count : (pl.items ? pl.items.length : 0);
          var isVert = pl.orientation === 'vertical';
          return '<div class="file-item">'+
            '<div class="file-info">'+
            '<strong>'+pl.name+'</strong>'+
            '<small>'+(pl.description || '')+'</small>'+
            '<small>'+count+' '+L.items+'</small>'+
            '<span class="file-type-badge" style="'+(isVert?'background:rgba(255,230,102,0.12);color:var(--yellow)':'background:rgba(255,140,0,0.12);color:var(--orange)')+'">'+(isVert?L.vertical:L.horizontal)+'</span>'+
            (pl.shuffle_enabled ? '<span class="file-type-badge" style="background:rgba(255,27,141,0.12);color:var(--magenta)">'+L.shuffle+'</span>':'')+
            (pl.repeat_enabled  ? '<span class="file-type-badge" style="background:rgba(0,200,150,0.12);color:#00c896">'+L.repeat+'</span>':'')+
            '</div>'+
            '<button class="btn btn-outline btn-sm" onclick="editPlaylist('+pl.id+')">'+L.edit+'</button>'+
            '<button class="btn btn-danger btn-sm" onclick="deletePlaylist('+pl.id+')">✕</button>'+
            '</div>';
        }).join('');
      } catch(e){ console.error(e); }
    };
    window.loadPlaylists._sonoroPatched = true;
  }

  var DAYS_I18N = {
    es: ['L','M','X','J','V','S','D'],
    en: ['M','T','W','T','F','S','S'],
    'pt-BR': ['S','T','Q','Q','S','S','D']
  };
  var SCHED_EMPTY = { es:'Sin horarios configurados', en:'No schedules configured', 'pt-BR':'Sem horários configurados' };
  function patchSchedulesRender(){
    if (typeof window.renderSchedules !== 'function' || window.renderSchedules._sonoroPatched) return;
    var KEYS = ['mon','tue','wed','thu','fri','sat','sun'];
    window.renderSchedules = function(deviceId, schedules){
      var c = document.getElementById('schedules_'+deviceId); if (!c) return;
      var LBL = DAYS_I18N[state.locale] || DAYS_I18N.es;
      if (!schedules || !schedules.length){
        c.innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:10px 0;">'+(SCHED_EMPTY[state.locale]||SCHED_EMPTY.es)+'</div>';
        return;
      }
      c.innerHTML = schedules.map(function(s, idx){
        var daysHtml = KEYS.map(function(k, i){
          var active = s.days.indexOf(k)>=0;
          return '<div onclick="toggleDay(\''+deviceId+'\','+idx+',\''+k+'\')" style="width:24px;height:24px;border-radius:50%;font-size:11px;font-weight:500;display:flex;align-items:center;justify-content:center;cursor:pointer;border:0.5px solid '+(active?'#185FA5':'#2e2e2e')+';background:'+(active?'#0C447C':'#1e1e1e')+';color:'+(active?'#B5D4F4':'#888')+';">'+LBL[i]+'</div>';
        }).join('');
        var toggleBg = s.active?'#27500A':'#2e2e2e';
        var toggleBdr = s.active?'#3B6D11':'#444';
        var dotColor = s.active?'#C0DD97':'#888';
        var dotPos = s.active?'right:2px':'left:2px';
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:0.5px solid #2e2e2e;" id="sched_'+deviceId+'_'+idx+'">'+
          '<div onclick="toggleScheduleActive(\''+deviceId+'\','+idx+')" style="width:32px;height:18px;background:'+toggleBg+';border-radius:9px;position:relative;flex-shrink:0;cursor:pointer;border:0.5px solid '+toggleBdr+';">'+
          '<div style="width:14px;height:14px;background:'+dotColor+';border-radius:50%;position:absolute;top:2px;'+dotPos+';"></div>'+
          '</div>'+
          '<div style="display:flex;gap:4px;">'+daysHtml+'</div>'+
          '<div style="display:flex;gap:6px;align-items:center;margin-left:auto;">'+
          '<span style="color:#00e676;font-size:11px;">ON</span>'+
          '<input type="time" value="'+s.time_on+'" onchange="updateScheduleField(\''+deviceId+'\','+idx+',\'time_on\',this.value)" style="font-size:12px;padding:3px 6px;background:#1e1e1e;color:#f0f0f0;border:0.5px solid #2e2e2e;border-radius:4px;width:80px;">'+
          '<span style="color:#FF1B8D;font-size:11px;">OFF</span>'+
          '<input type="time" value="'+s.time_off+'" onchange="updateScheduleField(\''+deviceId+'\','+idx+',\'time_off\',this.value)" style="font-size:12px;padding:3px 6px;background:#1e1e1e;color:#f0f0f0;border:0.5px solid #2e2e2e;border-radius:4px;width:80px;">'+
          '<button onclick="deleteSchedule(\''+deviceId+'\','+idx+')" style="background:none;border:none;color:#444;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;">✕</button>'+
          '</div>'+
          '</div>';
      }).join('');
    };
    window.renderSchedules._sonoroPatched = true;
  }

  var DEV_MAP = {
    en: {
      'Nombre del dispositivo':'Device name', 'Modo de pantalla':'Display mode',
      'Playlist HDMI 1':'Playlist HDMI 1', 'Playlist HDMI 2':'Playlist HDMI 2',
      'Playlist':'Playlist', 'Orientacion HDMI 1':'Orientation HDMI 1', 'Orientacion HDMI 2':'Orientation HDMI 2',
      'Orientacion':'Orientation', '-- Sin playlist --':'-- No playlist --',
      'Una pantalla':'Single screen', 'Mirror (2 TVs, misma lista)':'Mirror (2 TVs, same playlist)',
      'Dual — lista por pantalla':'Dual — playlist per screen', 'Videowall — imagen extendida':'Videowall — extended image',
      'Horizontal':'Horizontal', 'Vertical':'Vertical',
      'Configuracion Videowall':'Videowall configuration', 'Disposicion':'Layout',
      'Posicion TV 1':'TV 1 position', 'Primera (izq / arriba)':'First (left / top)', 'Segunda (der / abajo)':'Second (right / bottom)',
      'Sucursal de atencion asignada':'Assigned service branch', '— Sin sucursal —':'— No branch —',
      'Display de Turnos':'Queue display', 'Tema':'Theme', 'Oscuro':'Dark', 'Claro':'Light',
      'Color de marca':'Brand color', 'URL del logo':'Logo URL',
      'Guardar config display':'Save display config', 'Probar':'Test',
      'No hay dispositivos registrados.':'No devices registered yet.', 'Cargando...':'Loading…',
      'nunca':'never', 'Sin playlist':'No playlist',
      'CPU':'CPU', 'Version':'Version', 'Apagado':'Shutdown', 'TV':'TV',
      'Playlist activa':'Active playlist', 'Modo':'Mode',
      'Estado:':'Status:', 'Estado':'Status', 'Pantalla CEC':'CEC screen', 'Ambas':'Both', 'TV 1':'TV 1', 'TV 2':'TV 2',
      'Estado TV':'TV status', 'Encender':'Turn on', 'Apagar':'Turn off', 'Mute':'Mute', 'Unmute':'Unmute',
      'Entrada HDMI':'HDMI input', '-- Seleccionar --':'-- Select --', 'Cambiar':'Change',
      ' — activo':' — active',
      'Cronograma TV':'TV schedule', 'Sin horarios configurados':'No schedules configured', '+ Agregar horario':'+ Add schedule',
      'Online':'Online', 'Offline':'Offline',
      'ID:':'ID:', 'IP:':'IP:',
      'Mirror':'Mirror', 'Dual':'Dual', 'Videowall':'Videowall',
      'Verificar':'Verify', 'Verificando...':'Verifying…', 'Error al verificar':'Verification error',
      'Guardar y Aplicar':'Save and Apply', 'Generar código de pareo':'Generate pairing code',
      'Captura':'Screenshot', '↻ Reiniciar':'↻ Reboot', 'Detener player':'Stop player',
      'Configuracion':'Configuration', 'Dispositivos actualizados':'Devices updated'
    },
    'pt-BR': {
      'Nombre del dispositivo':'Nome do dispositivo', 'Modo de pantalla':'Modo de tela',
      'Playlist HDMI 1':'Playlist HDMI 1', 'Playlist HDMI 2':'Playlist HDMI 2',
      'Playlist':'Playlist', 'Orientacion HDMI 1':'Orientação HDMI 1', 'Orientacion HDMI 2':'Orientação HDMI 2',
      'Orientacion':'Orientação', '-- Sin playlist --':'-- Sem playlist --',
      'Una pantalla':'Uma tela', 'Mirror (2 TVs, misma lista)':'Espelho (2 TVs, mesma playlist)',
      'Dual — lista por pantalla':'Dupla — playlist por tela', 'Videowall — imagen extendida':'Videowall — imagem estendida',
      'Horizontal':'Horizontal', 'Vertical':'Vertical',
      'Configuracion Videowall':'Configuração Videowall', 'Disposicion':'Disposição',
      'Posicion TV 1':'Posição TV 1', 'Primera (izq / arriba)':'Primeira (esq / topo)', 'Segunda (der / abajo)':'Segunda (dir / abaixo)',
      'Sucursal de atencion asignada':'Filial de atendimento atribuída', '— Sin sucursal —':'— Sem filial —',
      'Display de Turnos':'Display de senhas', 'Tema':'Tema', 'Oscuro':'Escuro', 'Claro':'Claro',
      'Color de marca':'Cor da marca', 'URL del logo':'URL do logo',
      'Guardar config display':'Salvar config display', 'Probar':'Testar',
      'No hay dispositivos registrados.':'Nenhum dispositivo registrado.', 'Cargando...':'Carregando…',
      'nunca':'nunca', 'Sin playlist':'Sem playlist',
      'CPU':'CPU', 'Version':'Versão', 'Apagado':'Desligado', 'TV':'TV',
      'Playlist activa':'Playlist ativa', 'Modo':'Modo',
      'Estado:':'Status:', 'Estado':'Status', 'Pantalla CEC':'Tela CEC', 'Ambas':'Ambas', 'TV 1':'TV 1', 'TV 2':'TV 2',
      'Estado TV':'Status TV', 'Encender':'Ligar', 'Apagar':'Desligar', 'Mute':'Mudo', 'Unmute':'Ativar som',
      'Entrada HDMI':'Entrada HDMI', '-- Seleccionar --':'-- Selecionar --', 'Cambiar':'Alterar',
      ' — activo':' — ativo',
      'Cronograma TV':'Cronograma TV', 'Sin horarios configurados':'Sem horários configurados', '+ Agregar horario':'+ Adicionar horário',
      'Online':'On-line', 'Offline':'Off-line',
      'ID:':'ID:', 'IP:':'IP:',
      'Mirror':'Espelho', 'Dual':'Dupla', 'Videowall':'Videowall',
      'Verificar':'Verificar', 'Verificando...':'Verificando…', 'Error al verificar':'Erro ao verificar',
      'Guardar y Aplicar':'Salvar e Aplicar', 'Generar código de pareo':'Gerar código de pareamento',
      'Captura':'Captura', '↻ Reiniciar':'↻ Reiniciar', 'Detener player':'Parar player',
      'Configuracion':'Configuração', 'Dispositivos actualizados':'Dispositivos atualizados'
    }
  };
  function translateNode(root, map){
    if (!map || !root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())){
      var txt = n.nodeValue.trim();
      if (txt && map[txt]) n.nodeValue = n.nodeValue.replace(txt, map[txt]);
    }
    root.querySelectorAll('option').forEach(function(o){ var tt = o.textContent.trim(); if (map[tt]) o.textContent = map[tt]; });
    root.querySelectorAll('input[placeholder]').forEach(function(i){ var tt = i.placeholder; if (map[tt]) i.placeholder = map[tt]; });
    root.querySelectorAll('[title]').forEach(function(el){ var tt = el.getAttribute('title'); if (map[tt]) el.setAttribute('title', map[tt]); });
  }
  var DEV_TIME_LBL = {
    en:  { verified:'Verified', ago:'', s:'s ago', m:'m ago', h:'h ago', never:'never' },
    'pt-BR': { verified:'Verificado', ago:'há ', s:'s', m:'m', h:'h', never:'nunca' }
  };
  function translateDevTimePatterns(root, locale){
    var L = DEV_TIME_LBL[locale]; if (!L || !root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function(node){
      var v = node.nodeValue;
      if (!v || v.indexOf('Verificado')<0 && v.indexOf('hace')<0 && v.indexOf('nunca')<0) return;
      var out = v;
      out = out.replace(/Verificado\s+hace\s+(\d+)\s*([smh])/g, function(_,num,unit){
        if (locale === 'en') return L.verified+' '+num+(unit==='s'?L.s:unit==='m'?L.m:L.h);
        return L.verified+' '+L.ago+num+(unit==='s'?L.s:unit==='m'?L.m:L.h);
      });
      out = out.replace(/Verificado\s+nunca/g, L.verified+' '+L.never);
      out = out.replace(/^Verificado$/,' '+L.verified).trim();
      if (out !== v) node.nodeValue = out;
    });
  }
  function patchDevicesRender(){
    if (typeof window.loadDevices !== 'function' || window.loadDevices._sonoroPatched) return;
    var orig = window.loadDevices;
    window.loadDevices = async function(){
      var r = await orig.apply(this, arguments);
      var el = document.getElementById('devices-list');
      if (el && state.locale !== 'es') { translateNode(el, DEV_MAP[state.locale]); translateDevTimePatterns(el, state.locale); }
      return r;
    };
    window.loadDevices._sonoroPatched = true;
    // Patch verifyDevice: it rewrites #lastseen_* asynchronously in Spanish
    if (typeof window.verifyDevice === 'function' && !window.verifyDevice._sonoroPatched){
      var origV = window.verifyDevice;
      window.verifyDevice = async function(deviceId){
        var r = await origV.apply(this, arguments);
        if (state.locale !== 'es'){
          var el = document.getElementById('lastseen_'+deviceId);
          if (el){
            var map = DEV_MAP[state.locale] || {};
            var t = el.textContent;
            if (map[t]) el.textContent = map[t];
            else translateDevTimePatterns(el, state.locale);
          }
        }
        return r;
      };
      window.verifyDevice._sonoroPatched = true;
    }
  }

  // Toast/status i18n for hardcoded showStatus calls (playlist orientation warning, etc.)
  var STATUS_PATTERNS = {
    en: [
      { re:/^La playlist seleccionada para HDMI (\d) \((\w+)\) no coincide con la orientación del dispositivo \((\w+)\)\. Cambia la orientación o selecciona una playlist (\w+)\.$/,
        fn:function(m){ return 'The playlist selected for HDMI '+m[1]+' ('+m[2]+') does not match the device orientation ('+m[3]+'). Change the orientation or select a '+m[4]+' playlist.'; } },
      { re:/^Espera, hay una acción TV en curso\.\.\.$/, fn:function(){ return 'Please wait, a TV action is in progress…'; } },
      { re:/^Dispositivos actualizados$/, fn:function(){ return 'Devices updated'; } },
      { re:/^Política Windows aplicada$/, fn:function(){ return 'Windows policy applied'; } },
      { re:/^Comando de reinicio enviado al player$/, fn:function(){ return 'Restart command sent to player'; } },
      { re:/^Selecciona una sucursal primero$/, fn:function(){ return 'Select a branch first'; } }
    ],
    'pt-BR': [
      { re:/^La playlist seleccionada para HDMI (\d) \((\w+)\) no coincide con la orientación del dispositivo \((\w+)\)\. Cambia la orientación o selecciona una playlist (\w+)\.$/,
        fn:function(m){ return 'A playlist selecionada para HDMI '+m[1]+' ('+m[2]+') não coincide com a orientação do dispositivo ('+m[3]+'). Altere a orientação ou selecione uma playlist '+m[4]+'.'; } },
      { re:/^Espera, hay una acción TV en curso\.\.\.$/, fn:function(){ return 'Aguarde, há uma ação de TV em curso…'; } },
      { re:/^Dispositivos actualizados$/, fn:function(){ return 'Dispositivos atualizados'; } },
      { re:/^Política Windows aplicada$/, fn:function(){ return 'Política Windows aplicada'; } },
      { re:/^Comando de reinicio enviado al player$/, fn:function(){ return 'Comando de reinício enviado ao player'; } },
      { re:/^Selecciona una sucursal primero$/, fn:function(){ return 'Selecione uma filial primeiro'; } }
    ]
  };
  // Fase 2g — TOAST_I18N: diccionario amplio de mensajes showStatus/alert
  // Cubre 142 literales extraídos de dashboard.html. Prefix-match para "Error: <detalle>".
  var TOAST_I18N = {
    'Agente agregado — credenciales enviadas por email': { en:'Agent added — credentials sent by email', 'pt-BR':'Agente adicionado — credenciais enviadas por email' },
    'Agente eliminado': { en:'Agent removed', 'pt-BR':'Agente removido' },
    'Agrega proveedores al directorio primero': { en:'Add providers to the directory first', 'pt-BR':'Adicione fornecedores ao diretório primeiro' },
    'Batch revocado': { en:'Batch revoked', 'pt-BR':'Lote revogado' },
    'Bloqueo creado': { en:'Block created', 'pt-BR':'Bloqueio criado' },
    'Bloqueo eliminado': { en:'Block removed', 'pt-BR':'Bloqueio removido' },
    'Cita creada correctamente': { en:'Appointment created', 'pt-BR':'Agendamento criado' },
    'Citas no habilitadas para tu cuenta.': { en:'Appointments not enabled for your account.', 'pt-BR':'Agendamentos não habilitados na sua conta.' },
    'Comando de reinicio enviado al player': { en:'Restart command sent to player', 'pt-BR':'Comando de reinício enviado ao player' },
    'Completa todos los campos': { en:'Fill in all fields', 'pt-BR':'Preencha todos os campos' },
    'Comprobante enviado. Revisaremos y confirmaremos.': { en:'Proof submitted. We will review and confirm.', 'pt-BR':'Comprovante enviado. Vamos revisar e confirmar.' },
    'Comprobante guardado': { en:'Proof saved', 'pt-BR':'Comprovante salvo' },
    'Configuración del display guardada': { en:'Display configuration saved', 'pt-BR':'Configuração do display salva' },
    'Contraseña cambiada correctamente': { en:'Password changed successfully', 'pt-BR':'Senha alterada com sucesso' },
    'Cronograma guardado y aplicado en el reproductor': { en:'Schedule saved and applied on the player', 'pt-BR':'Cronograma salvo e aplicado no player' },
    'Cue eliminado': { en:'Cue removed', 'pt-BR':'Cue removido' },
    'Código copiado': { en:'Code copied', 'pt-BR':'Código copiado' },
    'Datos de cita incompletos.': { en:'Incomplete appointment data.', 'pt-BR':'Dados de agendamento incompletos.' },
    'Dispositivo guardado correctamente': { en:'Device saved successfully', 'pt-BR':'Dispositivo salvo com sucesso' },
    'Dispositivo reiniciando...': { en:'Device rebooting…', 'pt-BR':'Dispositivo reiniciando…' },
    'Dispositivos actualizados': { en:'Devices updated', 'pt-BR':'Dispositivos atualizados' },
    'Documento guardado': { en:'Document saved', 'pt-BR':'Documento salvo' },
    'El PIN es requerido': { en:'PIN is required', 'pt-BR':'O PIN é obrigatório' },
    'El email es requerido': { en:'Email is required', 'pt-BR':'O email é obrigatório' },
    'El grupo debe tener al menos 2 cupos': { en:'The group must have at least 2 slots', 'pt-BR':'O grupo deve ter ao menos 2 vagas' },
    'El modo ya estaba aplicado.': { en:'The mode was already applied.', 'pt-BR':'O modo já estava aplicado.' },
    'El nombre es requerido': { en:'Name is required', 'pt-BR':'O nome é obrigatório' },
    'Enlace copiado': { en:'Link copied', 'pt-BR':'Link copiado' },
    'Error': { en:'Error', 'pt-BR':'Erro' },
    'Error al actualizar estado': { en:'Failed to update status', 'pt-BR':'Falha ao atualizar status' },
    'Error al actualizar precio': { en:'Failed to update price', 'pt-BR':'Falha ao atualizar preço' },
    'Error al copiar. Selecciona el campo manualmente.': { en:'Copy failed. Select the field manually.', 'pt-BR':'Falha ao copiar. Selecione o campo manualmente.' },
    'Error al eliminar': { en:'Failed to delete', 'pt-BR':'Falha ao excluir' },
    'Error al eliminar cue': { en:'Failed to delete cue', 'pt-BR':'Falha ao excluir cue' },
    'Error al eliminar el evento': { en:'Failed to delete event', 'pt-BR':'Falha ao excluir evento' },
    'Error al enviar cotización': { en:'Failed to send quote', 'pt-BR':'Falha ao enviar orçamento' },
    'Error al generar CSV': { en:'Failed to generate CSV', 'pt-BR':'Falha ao gerar CSV' },
    'Error al generar PDF': { en:'Failed to generate PDF', 'pt-BR':'Falha ao gerar PDF' },
    'Error al generar enlace': { en:'Failed to generate link', 'pt-BR':'Falha ao gerar link' },
    'Error al guardar': { en:'Failed to save', 'pt-BR':'Falha ao salvar' },
    'Error al guardar cue': { en:'Failed to save cue', 'pt-BR':'Falha ao salvar cue' },
    'Error al guardar presupuesto': { en:'Failed to save budget', 'pt-BR':'Falha ao salvar orçamento' },
    'Error al preparar impresión': { en:'Failed to prepare print', 'pt-BR':'Falha ao preparar impressão' },
    'Error al reiniciar: ': { en:'Reboot error: ', 'pt-BR':'Erro ao reiniciar: ' },
    'Error al subir comprobante': { en:'Failed to upload proof', 'pt-BR':'Falha ao enviar comprovante' },
    'Error al subir documento': { en:'Failed to upload document', 'pt-BR':'Falha ao enviar documento' },
    'Error cargando cotización': { en:'Error loading quote', 'pt-BR':'Erro ao carregar orçamento' },
    'Error cargando evento': { en:'Error loading event', 'pt-BR':'Erro ao carregar evento' },
    'Error cargando invitaciones': { en:'Error loading invitations', 'pt-BR':'Erro ao carregar convites' },
    'Error cargando licencias': { en:'Error loading licenses', 'pt-BR':'Erro ao carregar licenças' },
    'Error cargando perfil': { en:'Error loading profile', 'pt-BR':'Erro ao carregar perfil' },
    'Error cargando proveedores': { en:'Error loading providers', 'pt-BR':'Erro ao carregar fornecedores' },
    'Error cargando registros': { en:'Error loading records', 'pt-BR':'Erro ao carregar registros' },
    'Error cargando staff': { en:'Error loading staff', 'pt-BR':'Erro ao carregar equipe' },
    'Error de conexion con el servidor': { en:'Server connection error', 'pt-BR':'Erro de conexão com o servidor' },
    'Error de conexión': { en:'Connection error', 'pt-BR':'Erro de conexão' },
    'Error de conexión: ': { en:'Connection error: ', 'pt-BR':'Erro de conexão: ' },
    'Error de red': { en:'Network error', 'pt-BR':'Erro de rede' },
    'Error de red: ': { en:'Network error: ', 'pt-BR':'Erro de rede: ' },
    'Error de red al confirmar llegada.': { en:'Network error confirming arrival.', 'pt-BR':'Erro de rede ao confirmar chegada.' },
    'Error exportando CSV': { en:'Error exporting CSV', 'pt-BR':'Erro ao exportar CSV' },
    'Error generando PDF': { en:'Error generating PDF', 'pt-BR':'Erro ao gerar PDF' },
    'Error generando código': { en:'Error generating code', 'pt-BR':'Erro ao gerar código' },
    'Error generando token': { en:'Error generating token', 'pt-BR':'Erro ao gerar token' },
    'Error guardando cronograma: ': { en:'Error saving schedule: ', 'pt-BR':'Erro ao salvar cronograma: ' },
    'Error importando CSV': { en:'Error importing CSV', 'pt-BR':'Erro ao importar CSV' },
    'Error revocando': { en:'Error revoking', 'pt-BR':'Erro ao revogar' },
    'Error subiendo logo': { en:'Error uploading logo', 'pt-BR':'Erro ao enviar logo' },
    'Error: ': { en:'Error: ', 'pt-BR':'Erro: ' },
    'Espera, hay una acción TV en curso...': { en:'Please wait, a TV action is in progress…', 'pt-BR':'Aguarde, há uma ação de TV em curso…' },
    'Evento actualizado': { en:'Event updated', 'pt-BR':'Evento atualizado' },
    'Evento creado': { en:'Event created', 'pt-BR':'Evento criado' },
    'Evento eliminado': { en:'Event removed', 'pt-BR':'Evento removido' },
    'Formulario guardado': { en:'Form saved', 'pt-BR':'Formulário salvo' },
    'Guardado, pero error al reenviar: ': { en:'Saved, but resend failed: ', 'pt-BR':'Salvo, mas falha ao reenviar: ' },
    'Importando CSV...': { en:'Importing CSV…', 'pt-BR':'Importando CSV…' },
    'Ingresa un monto válido': { en:'Enter a valid amount', 'pt-BR':'Informe um valor válido' },
    'Ingresa un nombre': { en:'Enter a name', 'pt-BR':'Informe um nome' },
    'Ingresa un slug.': { en:'Enter a slug.', 'pt-BR':'Informe um slug.' },
    'Ingresa un valor válido': { en:'Enter a valid value', 'pt-BR':'Informe um valor válido' },
    'Inscrito actualizado': { en:'Registrant updated', 'pt-BR':'Inscrito atualizado' },
    'La nueva contraseña debe tener al menos 8 caracteres': { en:'New password must be at least 8 characters', 'pt-BR':'A nova senha deve ter ao menos 8 caracteres' },
    'Las contraseñas no coinciden': { en:'Passwords do not match', 'pt-BR':'As senhas não coincidem' },
    'Link copiado': { en:'Link copied', 'pt-BR':'Link copiado' },
    'Llave BRE-B copiada': { en:'BRE-B key copied', 'pt-BR':'Chave BRE-B copiada' },
    'Logo actualizado': { en:'Logo updated', 'pt-BR':'Logo atualizado' },
    'Modulos actualizados': { en:'Modules updated', 'pt-BR':'Módulos atualizados' },
    'No se pudieron cargar las sucursales: ': { en:'Could not load branches: ', 'pt-BR':'Não foi possível carregar as filiais: ' },
    'No se pudo copiar': { en:'Could not copy', 'pt-BR':'Não foi possível copiar' },
    'Nombre actualizado': { en:'Name updated', 'pt-BR':'Nome atualizado' },
    'Nombre demasiado corto': { en:'Name too short', 'pt-BR':'Nome muito curto' },
    'Nombre requerido': { en:'Name required', 'pt-BR':'Nome obrigatório' },
    'Nombre y fechas son obligatorios': { en:'Name and dates are required', 'pt-BR':'Nome e datas são obrigatórios' },
    'Nombre y prefijo requeridos': { en:'Name and prefix required', 'pt-BR':'Nome e prefixo obrigatórios' },
    'Nombre, fecha y horas son obligatorios': { en:'Name, date and times are required', 'pt-BR':'Nome, data e horários são obrigatórios' },
    'Orden creada. Sigue las instrucciones de pago.': { en:'Order created. Follow the payment instructions.', 'pt-BR':'Pedido criado. Siga as instruções de pagamento.' },
    'País guardado': { en:'Country saved', 'pt-BR':'País salvo' },
    'Permite ventanas emergentes para imprimir': { en:'Allow pop-ups to print', 'pt-BR':'Permita pop-ups para imprimir' },
    'Política Windows aplicada': { en:'Windows policy applied', 'pt-BR':'Política Windows aplicada' },
    'Precio actualizado': { en:'Price updated', 'pt-BR':'Preço atualizado' },
    'Presupuesto guardado': { en:'Budget saved', 'pt-BR':'Orçamento salvo' },
    'Primero asigna una sucursal al dispositivo y guarda.': { en:'First assign a branch to the device and save.', 'pt-BR':'Primeiro atribua uma filial ao dispositivo e salve.' },
    'Primero asigna una sucursal al dispositivo.': { en:'First assign a branch to the device.', 'pt-BR':'Primeiro atribua uma filial ao dispositivo.' },
    'Primero debes crear una sucursal antes de agendar citas.': { en:'You must create a branch before scheduling appointments.', 'pt-BR':'Você deve criar uma filial antes de agendar.' },
    'Proveedor agregado': { en:'Provider added', 'pt-BR':'Fornecedor adicionado' },
    'Proveedor eliminado': { en:'Provider removed', 'pt-BR':'Fornecedor removido' },
    'Proveedor eliminado del directorio': { en:'Provider removed from directory', 'pt-BR':'Fornecedor removido do diretório' },
    'Proveedor quitado del evento': { en:'Provider removed from event', 'pt-BR':'Fornecedor removido do evento' },
    'Prueba de 30 días activada': { en:'30-day trial activated', 'pt-BR':'Teste de 30 dias ativado' },
    'Registro aprobado, QR enviado': { en:'Registration approved, QR sent', 'pt-BR':'Registro aprovado, QR enviado' },
    'Registro eliminado': { en:'Registration removed', 'pt-BR':'Registro removido' },
    'Reiniciando... vuelve en ~40 segundos': { en:'Rebooting… back in ~40 seconds', 'pt-BR':'Reiniciando… volta em ~40 segundos' },
    'Selecciona al menos una sesión': { en:'Select at least one session', 'pt-BR':'Selecione ao menos uma sessão' },
    'Selecciona un proveedor del directorio': { en:'Select a provider from the directory', 'pt-BR':'Selecione um fornecedor do diretório' },
    'Selecciona un rol': { en:'Select a role', 'pt-BR':'Selecione um papel' },
    'Selecciona una sesión primero': { en:'Select a session first', 'pt-BR':'Selecione uma sessão primeiro' },
    'Selecciona una sucursal primero': { en:'Select a branch first', 'pt-BR':'Selecione uma filial primeiro' },
    'Servicio agregado': { en:'Service added', 'pt-BR':'Serviço adicionado' },
    'Servicios actualizados': { en:'Services updated', 'pt-BR':'Serviços atualizados' },
    'Sesión eliminada': { en:'Session removed', 'pt-BR':'Sessão removida' },
    'Sin registros para imprimir': { en:'No records to print', 'pt-BR':'Sem registros para imprimir' },
    'Slug guardado correctamente.': { en:'Slug saved successfully.', 'pt-BR':'Slug salvo com sucesso.' },
    'Slug inválido: solo minúsculas, números y guiones (2–60 caracteres).': { en:'Invalid slug: lowercase, numbers and hyphens only (2–60 characters).', 'pt-BR':'Slug inválido: apenas minúsculas, números e hífens (2–60 caracteres).' },
    'Smart TV creado': { en:'Smart TV created', 'pt-BR':'Smart TV criada' },
    'Staff agregado': { en:'Staff added', 'pt-BR':'Equipe adicionada' },
    'Staff eliminado': { en:'Staff removed', 'pt-BR':'Equipe removida' },
    'Sucursal eliminada': { en:'Branch removed', 'pt-BR':'Filial removida' },
    'Sucursal no encontrada.': { en:'Branch not found.', 'pt-BR':'Filial não encontrada.' },
    'Token copiado al portapapeles.': { en:'Token copied to clipboard.', 'pt-BR':'Token copiado para a área de transferência.' },
    'Token revocado': { en:'Token revoked', 'pt-BR':'Token revogado' },
    'Token rotado. Reconfigura el kiosko con el nuevo token.': { en:'Token rotated. Reconfigure the kiosk with the new token.', 'pt-BR':'Token rotacionado. Reconfigure o kiosk com o novo token.' },
    'Turno de prueba enviado al display (A-99 / Prueba Display)': { en:'Test ticket sent to display (A-99 / Display Test)', 'pt-BR':'Senha de teste enviada ao display (A-99 / Teste Display)' },
    'Título y hora son requeridos': { en:'Title and time are required', 'pt-BR':'Título e hora são obrigatórios' },
    'URL copiada': { en:'URL copied', 'pt-BR':'URL copiada' },
    'URL copiada al portapapeles.': { en:'URL copied to clipboard.', 'pt-BR':'URL copiada para a área de transferência.' },
    'URL copiada.': { en:'URL copied.', 'pt-BR':'URL copiada.' },
    'URL pública generada': { en:'Public URL generated', 'pt-BR':'URL pública gerada' },
    'Ventanilla agregada': { en:'Window added', 'pt-BR':'Guichê adicionado' },
    'Ventanilla eliminada': { en:'Window removed', 'pt-BR':'Guichê removido' },
    // Fase 2g — confirm() prompts
    '¿Aprobar todos los registros pendientes de este batch? Se enviará el email con QR a cada persona.': { en:'Approve all pending records in this batch? An email with QR will be sent to each person.', 'pt-BR':'Aprovar todos os registros pendentes deste lote? Um e-mail com QR será enviado a cada pessoa.' },
    '¿Confirmar llegada de ': { en:'Confirm arrival of ', 'pt-BR':'Confirmar chegada de ' },
    '¿Eliminar archivo?': { en:'Delete file?', 'pt-BR':'Excluir arquivo?' },
    '¿Eliminar esta sesión?': { en:'Delete this session?', 'pt-BR':'Excluir esta sessão?' },
    '¿Eliminar esta ventanilla? Esta acción no se puede deshacer.': { en:'Delete this window? This action cannot be undone.', 'pt-BR':'Excluir este guichê? Esta ação não pode ser desfeita.' },
    '¿Eliminar este agente?': { en:'Delete this agent?', 'pt-BR':'Excluir este agente?' },
    '¿Eliminar este bloqueo de horario?': { en:'Delete this schedule block?', 'pt-BR':'Excluir este bloqueio de horário?' },
    '¿Eliminar este cue?': { en:'Delete this cue?', 'pt-BR':'Excluir este cue?' },
    '¿Eliminar lista?': { en:'Delete playlist?', 'pt-BR':'Excluir playlist?' },
    '¿Eliminar permanentemente este registro? Esta acción no se puede deshacer.': { en:'Permanently delete this record? This action cannot be undone.', 'pt-BR':'Excluir permanentemente este registro? Esta ação não pode ser desfeita.' },
    '¿Reenviar correo con el QR al inscrito?': { en:'Resend QR email to registrant?', 'pt-BR':'Reenviar e-mail com QR ao inscrito?' },
    '¿Reiniciar el dispositivo? Tardará ~40 segundos en volver.': { en:'Reboot the device? It will take ~40 seconds to return.', 'pt-BR':'Reiniciar o dispositivo? Levará ~40 segundos para voltar.' },
    '¿Revocar este batch? El link dejará de funcionar para nuevos claims. Los registros ya creados se conservan.': { en:'Revoke this batch? The link will stop working for new claims. Existing records are kept.', 'pt-BR':'Revogar este lote? O link deixará de funcionar para novos claims. Os registros já criados são mantidos.' },
    '¿Revocar este token? La URL actual dejará de funcionar.': { en:'Revoke this token? The current URL will stop working.', 'pt-BR':'Revogar este token? A URL atual deixará de funcionar.' },
    '¿Rotar el token de kiosko? El kiosko actual dejará de funcionar hasta que se reconfigure con el nuevo token.': { en:'Rotate kiosk token? The current kiosk will stop working until reconfigured with the new token.', 'pt-BR':'Rotacionar o token do quiosque? O quiosque atual deixará de funcionar até ser reconfigurado com o novo token.' }
  };
  function translateToast(msg){
    if (!msg || typeof msg !== 'string') return msg;
    var loc = state.locale; if (loc === 'es') return msg;
    var entry = TOAST_I18N[msg];
    if (entry && entry[loc]) return entry[loc];
    // Prefix-match para "Error: <detalle>", "Error al reiniciar: <err>", etc.
    var bestKey = null;
    for (var key in TOAST_I18N){
      if (key.charAt(key.length-1) === ' ' || key.charAt(key.length-1) === ':' || /[: ]$/.test(key)){
        if (msg.indexOf(key) === 0 && (!bestKey || key.length > bestKey.length)) bestKey = key;
      }
    }
    if (bestKey){
      var e = TOAST_I18N[bestKey];
      if (e && e[loc]) return e[loc] + msg.substring(bestKey.length);
    }
    return msg;
  }
  function translateStatusMsg(msg){
    if (state.locale === 'es' || typeof msg !== 'string') return msg;
    // 1) Regex patrones dinámicos (playlist orientation warning, etc.)
    var list = STATUS_PATTERNS[state.locale];
    if (list){
      for (var i=0;i<list.length;i++){
        var m = msg.match(list[i].re);
        if (m) return list[i].fn(m);
      }
    }
    // 2) Diccionario TOAST_I18N (142 entradas + prefix-match)
    return translateToast(msg);
  }
  function patchShowStatus(){
    if (typeof window.showStatus === 'function' && !window.showStatus._sonoroPatched){
      var orig = window.showStatus;
      window.showStatus = function(msg, kind){ return orig.call(this, translateStatusMsg(msg), kind); };
      window.showStatus._sonoroPatched = true;
    }
    // Fase 2g — también monkey-patch window.alert para traducir alerts nativos
    if (typeof window.alert === 'function' && !window.alert._sonoroPatched){
      var origAlert = window.alert;
      window.alert = function(msg){ return origAlert.call(this, translateStatusMsg(msg)); };
      window.alert._sonoroPatched = true;
    }
    // Fase 2g — confirm() nativo (¿Eliminar lista?, ¿Estás seguro?, etc.)
    if (typeof window.confirm === 'function' && !window.confirm._sonoroPatched){
      var origConfirm = window.confirm;
      window.confirm = function(msg){ return origConfirm.call(this, translateStatusMsg(msg)); };
      window.confirm._sonoroPatched = true;
    }
    // Fase 2g — prompt() nativo (por si aparece en algún flow)
    if (typeof window.prompt === 'function' && !window.prompt._sonoroPatched){
      var origPrompt = window.prompt;
      window.prompt = function(msg, def){ return origPrompt.call(this, translateStatusMsg(msg), def); };
      window.prompt._sonoroPatched = true;
    }
  }

  var LIC_MODAL_MAP = {
    en: {
      'Nueva orden — Colombia':'New order — Colombia',
      'Elige el producto y método de pago. Al confirmar generaremos la orden.':'Choose product and payment method. Order is created on confirm.',
      'Producto':'Product', 'Periodicidad':'Billing period', 'Mensual':'Monthly', 'Anual':'Annual',
      'Monto a pagar':'Amount',
      'Pago con Mercado Pago':'Pay with Mercado Pago', 'Ir a Mercado Pago':'Go to Mercado Pago',
      'Pago con BRE-B (transferencia)':'Pay with BRE-B (transfer)',
      'Transfiere':'Transfer', 'a la llave:':'to the key:', 'Llave:':'Key:', 'Copiar':'Copy',
      'Titular: Daniel Esteban Pulgarin':'Account holder: Daniel Esteban Pulgarin',
      '¿Ya pagaste? Sube tu comprobante':'Already paid? Upload your proof',
      'Primero crea la orden abajo; luego súbelo desde el historial.':'First create the order below; then upload it from history.',
      'Cerrar':'Close', 'Crear orden':'Create order',
      'Licencia SONORO Smart TV':'SONORO Smart TV License',
      'Licencia SONORO Windows':'SONORO Windows License',
      'Licencia SONORO Player':'SONORO Player License',
      'Equipo SONORO Player, 12 meses de licencia incluida':'SONORO Player hardware, 12 months license included',
      'Activar prueba de 30 días':'Start 30-day trial',
      '1 prueba por cuenta, solo SONORO Smart TV Player. Al finalizar podrás continuar con una suscripción o dejar que expire.':'1 trial per account, SONORO Smart TV Player only. When it ends you can subscribe or let it expire.',
      'Incluye:':'Includes:',
      'pareo del navegador del Smart TV, reproducción de playlist, splash de marca y heartbeat en tiempo real.':'Smart TV browser pairing, playlist playback, branded splash and real-time heartbeat.',
      'Cancelar':'Cancel', 'Activar prueba':'Start trial',
      'Confirma tu país':'Confirm your country',
      'Lo usamos para mostrarte precios y métodos de pago correctos.':'We use it to show correct prices and payment methods.',
      'País':'Country'
    },
    'pt-BR': {
      'Nueva orden — Colombia':'Novo pedido — Colômbia',
      'Elige el producto y método de pago. Al confirmar generaremos la orden.':'Escolha o produto e método de pagamento. O pedido é criado ao confirmar.',
      'Producto':'Produto', 'Periodicidad':'Periodicidade', 'Mensual':'Mensal', 'Anual':'Anual',
      'Monto a pagar':'Valor a pagar',
      'Pago con Mercado Pago':'Pagamento com Mercado Pago', 'Ir a Mercado Pago':'Ir ao Mercado Pago',
      'Pago con BRE-B (transferencia)':'Pagamento com BRE-B (transferência)',
      'Transfiere':'Transfira', 'a la llave:':'à chave:', 'Llave:':'Chave:', 'Copiar':'Copiar',
      'Titular: Daniel Esteban Pulgarin':'Titular: Daniel Esteban Pulgarin',
      '¿Ya pagaste? Sube tu comprobante':'Já pagou? Envie seu comprovante',
      'Primero crea la orden abajo; luego súbelo desde el historial.':'Primeiro crie o pedido abaixo; depois envie-o pelo histórico.',
      'Cerrar':'Fechar', 'Crear orden':'Criar pedido',
      'Licencia SONORO Smart TV':'Licença SONORO Smart TV',
      'Licencia SONORO Windows':'Licença SONORO Windows',
      'Licencia SONORO Player':'Licença SONORO Player',
      'Equipo SONORO Player, 12 meses de licencia incluida':'Hardware SONORO Player, 12 meses de licença incluída',
      'Activar prueba de 30 días':'Ativar teste de 30 dias',
      '1 prueba por cuenta, solo SONORO Smart TV Player. Al finalizar podrás continuar con una suscripción o dejar que expire.':'1 teste por conta, apenas SONORO Smart TV Player. Ao terminar você pode assinar ou deixar expirar.',
      'Incluye:':'Inclui:',
      'pareo del navegador del Smart TV, reproducción de playlist, splash de marca y heartbeat en tiempo real.':'pareamento do navegador da Smart TV, reprodução de playlist, splash da marca e heartbeat em tempo real.',
      'Cancelar':'Cancelar', 'Activar prueba':'Ativar teste',
      'Confirma tu país':'Confirme seu país',
      'Lo usamos para mostrarte precios y métodos de pago correctos.':'Usamos para mostrar preços e métodos de pagamento corretos.',
      'País':'País'
    }
  };
  function translateLicModals(){
    if (state.locale === 'es') return;
    var map = LIC_MODAL_MAP[state.locale]; if (!map) return;
    ['licNewOrderModalCo','licNewOrderModalUsd','licTrialModal','licCountryModal'].forEach(function(id){
      var el = document.getElementById(id); if (el) translateNode(el, map);
    });
  }

  function translatePlaylistModalDyn(){
    var title = document.getElementById('playlistModalTitle');
    if (title){
      var txt = title.textContent.trim();
      if (txt === 'Editar Lista' || txt === 'Edit Playlist' || txt === 'Editar Playlist') title.textContent = t('plm.edit_title', 'Editar Lista');
      else title.textContent = t('plm.new_title', 'Nueva Lista');
    }
    var c = document.getElementById('playlistContentList');
    if (c){
      var p = c.querySelector('p');
      if (p){
        var pt = p.textContent.trim();
        if (pt==='Vacío' || pt==='Empty' || pt==='Vazio') p.textContent = t('plm.empty', 'Vacío');
      }
    }
    var sel = document.getElementById('contentSelector');
    if (sel){
      Array.prototype.forEach.call(sel.options, function(o){
        if (!o.value && (o.textContent.indexOf('Seleccionar archivo')>=0 || o.textContent.indexOf('Select file')>=0 || o.textContent.indexOf('Selecionar arquivo')>=0)){
          o.textContent = t('plm.select_file', '-- Seleccionar archivo --');
        }
      });
    }
  }
  function patchPlaylistModalHooks(){
    if (typeof window.openCreatePlaylistModal === 'function' && !window.openCreatePlaylistModal._sonoroPatched){
      var orig = window.openCreatePlaylistModal;
      window.openCreatePlaylistModal = function(){ var r = orig.apply(this, arguments); setTimeout(translatePlaylistModalDyn, 20); return r; };
      window.openCreatePlaylistModal._sonoroPatched = true;
    }
    if (typeof window.updateContentSelector === 'function' && !window.updateContentSelector._sonoroPatched){
      var origU = window.updateContentSelector;
      window.updateContentSelector = function(files){ var r = origU.apply(this, arguments); translatePlaylistModalDyn(); return r; };
      window.updateContentSelector._sonoroPatched = true;
    }
    if (typeof window.editPlaylist === 'function' && !window.editPlaylist._sonoroPatched){
      var origE = window.editPlaylist;
      window.editPlaylist = async function(id){
        var r = await origE.apply(this, arguments);
        var el = document.getElementById('playlistModalTitle');
        if (el) el.textContent = t('plm.edit_title', 'Editar Lista');
        return r;
      };
      window.editPlaylist._sonoroPatched = true;
    }
    if (typeof window.renderPlaylistContent === 'function' && !window.renderPlaylistContent._sonoroPatched){
      var origR = window.renderPlaylistContent;
      window.renderPlaylistContent = function(){ var r = origR.apply(this, arguments); translatePlaylistModalDyn(); return r; };
      window.renderPlaylistContent._sonoroPatched = true;
    }
  }
  function patchLicModalHooks(){
    ['openLicNewOrder','openLicTrialModal','openLicCountryModal'].forEach(function(fnName){
      var orig = window[fnName];
      if (typeof orig === 'function' && !orig._sonoroPatched){
        window[fnName] = function(){ var r = orig.apply(this, arguments); setTimeout(translateLicModals, 30); return r; };
        window[fnName]._sonoroPatched = true;
      }
    });
  }
  function applyThemeToggleLabel(){
    var btn = document.getElementById('themeToggleBtn'); if (!btn) return;
    var isLight = document.body.classList.contains('light') || document.documentElement.classList.contains('light');
    btn.textContent = isLight ? t('topbar.theme_dark', 'Oscuro') : t('topbar.theme_light', 'Claro');
  }
  function patchThemeToggle(){
    if (typeof window.toggleTheme !== 'function' || window.toggleTheme._sonoroPatched) return;
    var orig = window.toggleTheme;
    window.toggleTheme = function(){ var r = orig.apply(this, arguments); applyThemeToggleLabel(); return r; };
    window.toggleTheme._sonoroPatched = true;
  }
  function patchAll(){
    // Fase 2g — showStatus/alert primero + try/catch por patch para que un throw
    // en cualquier hook downstream no impida traducir toasts.
    try { patchShowStatus(); } catch(e){ console.warn('[i18n] patchShowStatus:', e); }
    try { patchLicRenders(); } catch(e){ console.warn('[i18n] patchLicRenders:', e); }
    try { patchContentRenders(); } catch(e){ console.warn('[i18n] patchContentRenders:', e); }
    try { patchPlaylistsRender(); } catch(e){ console.warn('[i18n] patchPlaylistsRender:', e); }
    try { patchSchedulesRender(); } catch(e){ console.warn('[i18n] patchSchedulesRender:', e); }
    try { patchDevicesRender(); } catch(e){ console.warn('[i18n] patchDevicesRender:', e); }
    try { patchPlaylistModalHooks(); } catch(e){ console.warn('[i18n] patchPlaylistModalHooks:', e); }
    try { patchLicModalHooks(); } catch(e){ console.warn('[i18n] patchLicModalHooks:', e); }
    try { patchThemeToggle(); } catch(e){ console.warn('[i18n] patchThemeToggle:', e); }
    try { applyThemeToggleLabel(); } catch(e){}
  }

  // Wrapper setLocale with full re-render chain
  window.SonoroI18n.setLocale = function(loc){
    baseSetLocale(loc);
    patchAll();
    translateLicModals();
    try { if (typeof licUpdateCoPayLink === 'function' && document.getElementById('licOrderProductCo')) licUpdateCoPayLink(); } catch(e){}
    try {
      var rEl = document.getElementById('mcRole');
      if (rEl && rEl.dataset.role){
        var rk = rEl.dataset.role;
        rEl.textContent = t('mc.role_'+(rk==='admin'?'admin':rk==='agent'?'agent':'client'), rEl.textContent);
      }
    } catch(e){}
    try {
      if (typeof deviceSchedules === 'object' && deviceSchedules){
        Object.keys(deviceSchedules).forEach(function(id){
          if (typeof renderSchedules === 'function') renderSchedules(id, deviceSchedules[id]);
        });
      }
    } catch(e){}
    var cu = window.currentUser || (function(){ try { return JSON.parse(localStorage.getItem('currentUser')||'null'); } catch(e){ return null; } })();
    if (cu){
      if (typeof window.loadLicensesData === 'function') window.loadLicensesData();
      if (typeof window.loadContent === 'function')      window.loadContent();
      if (typeof window.loadPlaylists === 'function')    window.loadPlaylists();
      if (typeof window.loadDevices === 'function')      window.loadDevices();
    }
    try { document.dispatchEvent(new CustomEvent('sonoro:localechange', { detail:{ locale:loc } })); } catch(e){}
  };

  // Bootstrap
  function bootstrap(){
    var fromUrl = null;
    try { var _m = /[?&]lang=([^&]+)/.exec(location.search||''); if (_m) fromUrl = decodeURIComponent(_m[1]); } catch(e){}
    var stored = null;
    try { stored = localStorage.getItem('sonoro_locale'); } catch(e){}
    if (fromUrl){ var _r = resolveLocale(fromUrl); try { localStorage.setItem('sonoro_locale', _r); } catch(e){} stored = _r; }
    var fromUser = null;
    try { var cu = JSON.parse(localStorage.getItem('currentUser')||'null'); if (cu && cu.locale) fromUser = cu.locale; } catch(e){}
    var initial = resolveLocale(stored || fromUser || detectFromNavigator());
    state.locale = initial;
    state.dict = LOCALES[initial];
    applyI18n(document);
    patchAll();
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
