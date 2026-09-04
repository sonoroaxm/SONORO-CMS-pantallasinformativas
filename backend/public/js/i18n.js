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
      dev: { title:'Gestión de Dispositivos', add_smarttv:'+ Agregar Smart TV', gen_code:'+ Generar Código', no_devices:'Aún no tienes dispositivos activados.', last_seen:'Última conexión', temp:'Temperatura', screenshot:'Captura', logs:'Logs', reboot:'Reiniciar', ssh:'SSH', unassigned:'Sin asignar', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Espejo', mode_pro:'Independiente' },
      login: { sub:'CMS · Pantallas Informativas', tab_signin:'Ingresar', tab_signup:'Registrarse',
        email:'Email', password:'Contraseña', name:'Nombre',
        signin_btn:'Ingresar', signup_btn:'Crear Cuenta',
        forgot:'Olvidé mi contraseña', forgot_send:'Enviar instrucciones' },
      topbar: { session:'Sesión', logout:'Cerrar Sesión', theme_light:'Claro', theme_dark:'Oscuro' },
      sidebar: { group_content:'Gestión de<br>Contenido', tab_content:'Contenido', tab_playlists:'Listas', tab_devices:'Dispositivos',
        group_licenses:'Licencias', tab_my_licenses:'Mis Licencias', tab_my_account:'Mi Cuenta' },
      lic: { title:'Mis Licencias', buy_btn:'+ Comprar licencia',
        kpi_active:'Activas', kpi_trial:'En prueba', kpi_expiring:'Por vencer (30d)', kpi_pending:'Órdenes pendientes',
        trial_title:'Prueba SONORO Smart TV 30 días gratis', trial_sub:'Convierte cualquier Smart TV en una pantalla informativa. Sin tarjeta. 1 prueba por cuenta.', trial_btn:'Activar prueba',
        active_title:'Licencias activas', history_title:'Historial de órdenes',
        col_order:'Orden', col_product:'Producto', col_amount:'Monto', col_status:'Estado', col_date:'Fecha', col_action:'Acción' },
      mc: { title:'Mi Cuenta', personal_info:'Información personal',
        email:'Email', name:'Nombre', role:'Rol', country:'País',
        change_pw:'Cambiar contraseña', pw_current:'Contraseña actual', pw_new:'Nueva contraseña (mín. 8)', pw_confirm:'Confirmar nueva contraseña', change_pw_btn:'Cambiar contraseña',
        role_admin:'Administrador', role_agent:'Agente', role_client:'Cliente' },
      stv: { add_title:'Agregar Smart TV', add_sub:'Se creará el dispositivo y se generará un código de pareo para el TV.', name:'Nombre', name_ph:'Ej. TV Recepción', orientation:'Orientación', horizontal:'Horizontal', vertical:'Vertical', create_and_generate:'Crear y generar código', pair_title:'Código de pareo Smart TV', expires:'Expira:', remaining:'Restante:' },
      usd: { title:'Nueva orden — Internacional', sub:'Elige el producto y suscríbete vía PayPal.', product:'Producto', prod_smarttv:'SONORO Smart TV — suscripción mensual', prod_windows:'SONORO Windows — suscripción mensual', prod_player:'SONORO Player — suscripción mensual', amount:'Monto', pay_paypal:'Pago con PayPal', subscribe:'Suscribirse en PayPal', create_order:'Crear orden' },
      pro: { badge:'Plan Pro activo', desc:'— envía la misma playlist a múltiples pantallas y agrúpalas por sede.', tags:'Bulk Push · Multi-sede · Reportes por ubicación', cta:'Ir a Sedes & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Cerrar Sesión' },
      sb: { mi_cuenta:'Mi Cuenta', resumen:'Resumen', mis_dispositivos:'Mis Dispositivos', mis_sedes:'Mis Sedes', ver_sedes:'Ver Sedes', contenido:'Contenido', bulkpush:'Bulk Push' },
      ov: { title:'Resumen', refresh:'Actualizar', server:'Servidor CMS', operative:'Operativo', devices:'Dispositivos', sedes:'Sedes', playlists:'Playlists activas', playing_now:'en reproducción ahora', content:'Contenido', files:'archivos', status_by_sede:'Estado por sede', loading_sedes:'Cargando sedes...' },
      md: { title:'Mis Dispositivos', sub:'Dispositivos asignados a tu cuenta' },
      ms: { title:'Mis Sedes', sub:'Gestión de ubicaciones y dispositivos' },
      bp: { title:'Bulk Push', sub:'Envío masivo de playlist a múltiples dispositivos',
        step_playlist:'Playlist', step_dest:'Destino', step_format:'Formato', step_confirm:'Confirmar',
        s1_label:'1 — Playlist a enviar', select_playlist:'— Seleccionar playlist —',
        s2_label:'2 — Nivel geográfico de destino', country:'País', city:'Ciudad', branch:'Sede', all_f:'Todas', route:'Ruta:',
        s3_label:'3 — Formato de pantalla', all_sub:'Sin filtrar por orientación', horizontal:'Horizontal', horizontal_sub:'Pantallas apaisadas', vertical:'Vertical', vertical_sub:'Pantallas de pie',
        s4_label:'4 — Previsualizar y confirmar', preview:'Previsualizar', recv_title:'Dispositivos que recibirán la playlist', devices:'dispositivos',
        th_device:'Dispositivo', th_city_branch:'Ciudad / Sede', th_ports:'Puertos', th_current:'Playlist actual', th_action:'Acción', send_all:'Enviar a todos' },
      toast: { language_updated:'Idioma actualizado' }
    },
    en: {
      common: { loading:'Loading…', save:'Save', change:'Change', refresh:'↻ Refresh', delete:'Delete', edit:'Edit', cancel:'Cancel', close:'Close', copy:'Copy', copied:'Copied', yes:'Yes', no:'No', online:'Online', offline:'Offline' },
      cnt: { title:'Content Manager', upload_title:'Upload File', upload_btn:'↑ Upload', uploading:'Uploading', preview:'Preview', files:'Files', choose_file:'Choose file', no_file:'No file', no_files:'No content uploaded yet.', assigned_to:'Assigned to', duration:'Duration', size:'Size', type_video:'Video', type_image:'Image' },
      plm: { new_title:'New Playlist', edit_title:'Edit Playlist', name:'Name', name_ph:'Playlist name', desc:'Description', desc_ph:'Description', orientation:'Screen orientation', horizontal:'Horizontal (16:9)', vertical:'Vertical (9:16)', shuffle:'Shuffle order', repeat:'Loop forever', add_content:'Add content', select_file:'-- Select file --', add:'+ Add', content:'Content', empty:'Empty' },
      act: { title:'Activation Codes', gen_btn:'Generate code', code_label:'Activation code', existing:'Generated codes', dev_name:'Device name (optional)', dev_name_ph:'E.g. Reception, Waiting room...' },
      pl: { title:'Playlists', new_btn:'+ New Playlist', no_playlists:'No playlists created yet.', items:'items', empty:'Empty playlist', assign:'Assign', unassign:'Unassign', rename:'Rename', duplicate:'Duplicate' },
      dev: { title:'Device Management', add_smarttv:'+ Add Smart TV', gen_code:'+ Generate Code', no_devices:'No devices activated yet.', last_seen:'Last seen', temp:'Temperature', screenshot:'Screenshot', logs:'Logs', reboot:'Reboot', ssh:'SSH', unassigned:'Unassigned', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Mirror', mode_pro:'Independent' },
      login: { sub:'CMS · Digital Signage', tab_signin:'Sign in', tab_signup:'Sign up',
        email:'Email', password:'Password', name:'Name',
        signin_btn:'Sign in', signup_btn:'Create account',
        forgot:'Forgot your password?', forgot_send:'Send instructions' },
      topbar: { session:'Session', logout:'Log out', theme_light:'Light', theme_dark:'Dark' },
      sidebar: { group_content:'Content<br>Management', tab_content:'Content', tab_playlists:'Playlists', tab_devices:'Devices',
        group_licenses:'Licenses', tab_my_licenses:'My Licenses', tab_my_account:'My Account' },
      lic: { title:'My Licenses', buy_btn:'+ Buy license',
        kpi_active:'Active', kpi_trial:'Trial', kpi_expiring:'Expiring (30d)', kpi_pending:'Pending orders',
        trial_title:'Try SONORO Smart TV free for 30 days', trial_sub:'Turn any Smart TV into a digital signage screen. No card required. 1 trial per account.', trial_btn:'Start trial',
        active_title:'Active licenses', history_title:'Order history',
        col_order:'Order', col_product:'Product', col_amount:'Amount', col_status:'Status', col_date:'Date', col_action:'Action' },
      mc: { title:'My Account', personal_info:'Personal information',
        email:'Email', name:'Name', role:'Role', country:'Country',
        change_pw:'Change password', pw_current:'Current password', pw_new:'New password (min. 8)', pw_confirm:'Confirm new password', change_pw_btn:'Change password',
        role_admin:'Administrator', role_agent:'Agent', role_client:'Client' },
      stv: { add_title:'Add Smart TV', add_sub:'The device will be created and a pairing code will be generated for the TV.', name:'Name', name_ph:'E.g. Reception TV', orientation:'Orientation', horizontal:'Horizontal', vertical:'Vertical', create_and_generate:'Create and generate code', pair_title:'Smart TV pairing code', expires:'Expires:', remaining:'Remaining:' },
      usd: { title:'New order — International', sub:'Choose product and subscribe via PayPal.', product:'Product', prod_smarttv:'SONORO Smart TV — monthly subscription', prod_windows:'SONORO Windows — monthly subscription', prod_player:'SONORO Player — monthly subscription', amount:'Amount', pay_paypal:'Pay with PayPal', subscribe:'Subscribe on PayPal', create_order:'Create order' },
      pro: { badge:'Pro Plan active', desc:'— push the same playlist to multiple screens and group them by location.', tags:'Bulk Push · Multi-site · Reports by location', cta:'Go to Sites & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Log out' },
      sb: { mi_cuenta:'My Account', resumen:'Overview', mis_dispositivos:'My Devices', mis_sedes:'My Sites', ver_sedes:'View Sites', contenido:'Content', bulkpush:'Bulk Push' },
      ov: { title:'Overview', refresh:'Refresh', server:'CMS Server', operative:'Operational', devices:'Devices', sedes:'Sites', playlists:'Active playlists', playing_now:'playing now', content:'Content', files:'files', status_by_sede:'Status by site', loading_sedes:'Loading sites...' },
      md: { title:'My Devices', sub:'Devices assigned to your account' },
      ms: { title:'My Sites', sub:'Manage locations and devices' },
      bp: { title:'Bulk Push', sub:'Push a playlist to multiple devices at once',
        step_playlist:'Playlist', step_dest:'Destination', step_format:'Format', step_confirm:'Confirm',
        s1_label:'1 — Playlist to push', select_playlist:'— Select playlist —',
        s2_label:'2 — Geographic destination level', country:'Country', city:'City', branch:'Site', all_f:'All', route:'Route:',
        s3_label:'3 — Screen format', all_sub:'No orientation filter', horizontal:'Horizontal', horizontal_sub:'Landscape screens', vertical:'Vertical', vertical_sub:'Portrait screens',
        s4_label:'4 — Preview and confirm', preview:'Preview', recv_title:'Devices that will receive the playlist', devices:'devices',
        th_device:'Device', th_city_branch:'City / Site', th_ports:'Ports', th_current:'Current playlist', th_action:'Action', send_all:'Send to all' },
      toast: { language_updated:'Language updated' }
    },
    'pt-BR': {
      common: { loading:'Carregando…', save:'Salvar', change:'Alterar', refresh:'↻ Atualizar', delete:'Excluir', edit:'Editar', cancel:'Cancelar', close:'Fechar', copy:'Copiar', copied:'Copiado', yes:'Sim', no:'Não', online:'On-line', offline:'Off-line' },
      cnt: { title:'Gerenciador de Conteúdo', upload_title:'Enviar Arquivo', upload_btn:'↑ Enviar', uploading:'Enviando', preview:'Pré-visualização', files:'Arquivos', choose_file:'Escolher arquivo', no_file:'Sem arquivo', no_files:'Nenhum conteúdo enviado ainda.', assigned_to:'Atribuído a', duration:'Duração', size:'Tamanho', type_video:'Vídeo', type_image:'Imagem' },
      plm: { new_title:'Nova Playlist', edit_title:'Editar Playlist', name:'Nome', name_ph:'Nome da playlist', desc:'Descrição', desc_ph:'Descrição', orientation:'Orientação da tela', horizontal:'Horizontal (16:9)', vertical:'Vertical (9:16)', shuffle:'Ordem aleatória', repeat:'Repetir infinitamente', add_content:'Adicionar conteúdo', select_file:'-- Selecionar arquivo --', add:'+ Adicionar', content:'Conteúdo', empty:'Vazio' },
      act: { title:'Códigos de Ativação', gen_btn:'Gerar código', code_label:'Código de ativação', existing:'Códigos gerados', dev_name:'Nome do dispositivo (opcional)', dev_name_ph:'Ex: Recepção, Sala de espera...' },
      pl: { title:'Playlists', new_btn:'+ Nova Playlist', no_playlists:'Nenhuma playlist criada ainda.', items:'itens', empty:'Playlist vazia', assign:'Atribuir', unassign:'Desatribuir', rename:'Renomear', duplicate:'Duplicar' },
      dev: { title:'Gestão de Dispositivos', add_smarttv:'+ Adicionar Smart TV', gen_code:'+ Gerar Código', no_devices:'Nenhum dispositivo ativado ainda.', last_seen:'Última conexão', temp:'Temperatura', screenshot:'Captura', logs:'Registros', reboot:'Reiniciar', ssh:'SSH', unassigned:'Não atribuído', hdmi1:'HDMI 1', hdmi2:'HDMI 2', mode_mirror:'Espelho', mode_pro:'Independente' },
      login: { sub:'CMS · Sinalização Digital', tab_signin:'Entrar', tab_signup:'Cadastrar',
        email:'E-mail', password:'Senha', name:'Nome',
        signin_btn:'Entrar', signup_btn:'Criar conta',
        forgot:'Esqueceu sua senha?', forgot_send:'Enviar instruções' },
      topbar: { session:'Sessão', logout:'Sair', theme_light:'Claro', theme_dark:'Escuro' },
      sidebar: { group_content:'Gestão de<br>Conteúdo', tab_content:'Conteúdo', tab_playlists:'Playlists', tab_devices:'Dispositivos',
        group_licenses:'Licenças', tab_my_licenses:'Minhas Licenças', tab_my_account:'Minha Conta' },
      lic: { title:'Minhas Licenças', buy_btn:'+ Comprar licença',
        kpi_active:'Ativas', kpi_trial:'Em teste', kpi_expiring:'A vencer (30d)', kpi_pending:'Pedidos pendentes',
        trial_title:'Teste SONORO Smart TV grátis por 30 dias', trial_sub:'Transforme qualquer Smart TV em uma tela de sinalização. Sem cartão. 1 teste por conta.', trial_btn:'Iniciar teste',
        active_title:'Licenças ativas', history_title:'Histórico de pedidos',
        col_order:'Pedido', col_product:'Produto', col_amount:'Valor', col_status:'Status', col_date:'Data', col_action:'Ação' },
      mc: { title:'Minha Conta', personal_info:'Informações pessoais',
        email:'E-mail', name:'Nome', role:'Função', country:'País',
        change_pw:'Alterar senha', pw_current:'Senha atual', pw_new:'Nova senha (mín. 8)', pw_confirm:'Confirmar nova senha', change_pw_btn:'Alterar senha',
        role_admin:'Administrador', role_agent:'Agente', role_client:'Cliente' },
      stv: { add_title:'Adicionar Smart TV', add_sub:'O dispositivo será criado e um código de pareamento será gerado para a TV.', name:'Nome', name_ph:'Ex. TV Recepção', orientation:'Orientação', horizontal:'Horizontal', vertical:'Vertical', create_and_generate:'Criar e gerar código', pair_title:'Código de pareamento Smart TV', expires:'Expira:', remaining:'Restante:' },
      usd: { title:'Novo pedido — Internacional', sub:'Escolha o produto e assine via PayPal.', product:'Produto', prod_smarttv:'SONORO Smart TV — assinatura mensal', prod_windows:'SONORO Windows — assinatura mensal', prod_player:'SONORO Player — assinatura mensal', amount:'Valor', pay_paypal:'Pagamento com PayPal', subscribe:'Assinar no PayPal', create_order:'Criar pedido' },
      pro: { badge:'Plano Pro ativo', desc:'— envie a mesma playlist para várias telas e agrupe-as por local.', tags:'Bulk Push · Multi-sede · Relatórios por local', cta:'Ir para Sedes & Bulk Push →' },
      tb: { admin:'Admin', super_admin:'Super Admin', logout:'Sair' },
      sb: { mi_cuenta:'Minha Conta', resumen:'Resumo', mis_dispositivos:'Meus Dispositivos', mis_sedes:'Minhas Sedes', ver_sedes:'Ver Sedes', contenido:'Conteúdo', bulkpush:'Bulk Push' },
      ov: { title:'Resumo', refresh:'Atualizar', server:'Servidor CMS', operative:'Operacional', devices:'Dispositivos', sedes:'Sedes', playlists:'Playlists ativas', playing_now:'em reprodução agora', content:'Conteúdo', files:'arquivos', status_by_sede:'Status por sede', loading_sedes:'Carregando sedes...' },
      md: { title:'Meus Dispositivos', sub:'Dispositivos atribuídos à sua conta' },
      ms: { title:'Minhas Sedes', sub:'Gestão de locais e dispositivos' },
      bp: { title:'Bulk Push', sub:'Envio em massa de playlist para vários dispositivos',
        step_playlist:'Playlist', step_dest:'Destino', step_format:'Formato', step_confirm:'Confirmar',
        s1_label:'1 — Playlist a enviar', select_playlist:'— Selecionar playlist —',
        s2_label:'2 — Nível geográfico de destino', country:'País', city:'Cidade', branch:'Sede', all_f:'Todas', route:'Rota:',
        s3_label:'3 — Formato de tela', all_sub:'Sem filtro de orientação', horizontal:'Horizontal', horizontal_sub:'Telas em paisagem', vertical:'Vertical', vertical_sub:'Telas em retrato',
        s4_label:'4 — Pré-visualizar e confirmar', preview:'Pré-visualizar', recv_title:'Dispositivos que receberão a playlist', devices:'dispositivos',
        th_device:'Dispositivo', th_city_branch:'Cidade / Sede', th_ports:'Portas', th_current:'Playlist atual', th_action:'Ação', send_all:'Enviar para todos' },
      toast: { language_updated:'Idioma atualizado' }
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
    es: { no_files:'No hay archivos', video:'video', image:'image' },
    en: { no_files:'No files',        video:'video', image:'image' },
    'pt-BR': { no_files:'Sem arquivos', video:'video', image:'image' }
  };
  function patchContentRenders(){
    if (typeof window.displayFiles !== 'function' || window.displayFiles._sonoroPatched) return;
    window.displayFiles = function(files){
      var el = document.getElementById('fileList'); if (!el) return;
      var L = CNT_DYN[state.locale] || CNT_DYN.es;
      if (!files || !files.length){ el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">'+L.no_files+'</p>'; return; }
      el.innerHTML = files.map(function(file){
        var size = ((file.size_bytes||file.size||0)/1024/1024).toFixed(2);
        var dur = (file.duration_ms || file.duration) ? '<small>'+(((file.duration_ms||file.duration*1000))/1000).toFixed(1)+'s</small>' : '';
        return '<div class="file-item" data-content-id="'+file.id+'">'+
          '<div class="file-info">'+
          '<strong>'+(file.title || file.name || file.filename)+'</strong>'+
          '<span class="file-type-badge '+(file.type==='image'?'badge-image':'badge-video')+'">'+(file.type==='image'?L.image:L.video)+'</span>'+
          '<small>'+size+' MB</small>'+dur+
          '</div>'+
          '<button class="btn btn-outline btn-sm" onclick="void 0">▶</button>'+
          '<button class="btn btn-danger btn-sm" onclick="void 0">✕</button>'+
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
            '<button class="btn btn-outline btn-sm">'+L.edit+'</button>'+
            '<button class="btn btn-danger btn-sm">✕</button>'+
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
      'Mirror':'Mirror', 'Dual':'Dual', 'Videowall':'Videowall'
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
      'Mirror':'Espelho', 'Dual':'Dupla', 'Videowall':'Videowall'
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
  function patchDevicesRender(){
    if (typeof window.loadDevices !== 'function' || window.loadDevices._sonoroPatched) return;
    var orig = window.loadDevices;
    window.loadDevices = async function(){
      var r = await orig.apply(this, arguments);
      var el = document.getElementById('devices-list');
      if (el && state.locale !== 'es') translateNode(el, DEV_MAP[state.locale]);
      return r;
    };
    window.loadDevices._sonoroPatched = true;
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
    patchLicRenders();
    patchContentRenders();
    patchPlaylistsRender();
    patchSchedulesRender();
    patchDevicesRender();
    patchPlaylistModalHooks();
    patchLicModalHooks();
    patchThemeToggle();
    applyThemeToggleLabel();
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
  };

  // Bootstrap
  function bootstrap(){
    var stored = null;
    try { stored = localStorage.getItem('sonoro_locale'); } catch(e){}
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
