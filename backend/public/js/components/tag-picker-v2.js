/*
 * tag-picker-v2.js — Componente unificado de selección de tags RN/RE
 * Vanilla JS. Sin dependencias. Reemplaza el <select> plano de rueda-registro.html
 * y el autocomplete inline de rueda-mi-agenda.html.
 *
 * API:
 *   const pk = TagPickerV2.mount('#container', {
 *     tags:          [{id, slug, label, label_en, label_pt, category}],
 *     lang:          'es' | 'en' | 'pt',
 *     ruedaType:     'negocios' | 'empleo',
 *     max:           8,
 *     minPerBucket:  1,
 *     initialSelection: { offer:[id,...], demand:[id,...] },
 *     readOnly:      false,
 *     bucketLabels:  { offerTitle, offerHelp, demandTitle, demandHelp }, // opcional
 *     onChange:      (sel) => {}  // sel = { offer:[id], demand:[id] }
 *   });
 *   pk.setLang('en');
 *   pk.setReadOnly(true);
 *   pk.getSelection(); // { offer:[id], demand:[id] }
 *   pk.setSelection({ offer:[], demand:[] });
 *   pk.destroy();
 */
(function (global) {
  'use strict';

  const I18N = {
    searchPh: {es:'Buscar en el catálogo…', en:'Search catalog…', pt:'Buscar no catálogo…'},
    catAll:   {es:'Todas', en:'All', pt:'Todas'},
    empty:    {es:'Ningún tag coincide', en:'No matching tags', pt:'Nenhum tag corresponde'},
    emptyHint:{es:'Prueba con otra categoría o palabra clave.', en:'Try another category or keyword.', pt:'Tente outra categoria ou palavra-chave.'},
    chipEmpty:{es:'Aún no has elegido etiquetas.', en:'No tags selected yet.', pt:'Nenhuma tag selecionada.'},
    counter:  {es:'seleccionados', en:'selected', pt:'selecionados'},
    minMiss:  {es:'falta mínimo 1 por scope', en:'min 1 per bucket', pt:'mínimo 1 por scope'},
    maxHit:   {es:'Límite alcanzado — retira uno para añadir otro', en:'Limit reached — remove one to add another', pt:'Limite — remova uma para adicionar outra'},
    ok:       {es:'OK', en:'OK', pt:'OK'},
    // Defaults de etiquetas de scope (RN; mi-agenda/registro pueden sobrescribir vía bucketLabels)
    rnOfferT: {es:'Lo que ofrezco', en:"What I offer", pt:'O que ofereço'},
    rnOfferH: {es:'Productos · servicios · capacidades', en:'Products · services · capabilities', pt:'Produtos · serviços · capacidades'},
    rnDemT:   {es:'Lo que busco', en:"What I'm looking for", pt:'O que procuro'},
    rnDemH:   {es:'Proveedores · clientes · aliados', en:'Suppliers · clients · partners', pt:'Fornecedores · clientes · parceiros'},
    reOfferT: {es:'Me postulo', en:'Applicant', pt:'Candidato'},
    reOfferH: {es:'Me ofrezco en este rol / vertical', en:"I'm offering this role / vertical", pt:'Ofereço-me neste papel / vertical'},
    reDemT:   {es:'Busco talento', en:'Hiring', pt:'Busco talento'},
    reDemH:   {es:'Busco talento en este rol / vertical', en:'Looking for talent in this role / vertical', pt:'Procuro talento neste papel / vertical'},
  };

  function t(key, lang) { return (I18N[key] && I18N[key][lang]) || (I18N[key] && I18N[key].es) || key; }

  function pickLabel(tag, lang) {
    if (!tag) return '';
    if (lang === 'en') return tag.label_en || tag.label || '';
    if (lang === 'pt') return tag.label_pt || tag.label || '';
    return tag.label || '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function highlight(txt, q) {
    if (!q) return esc(txt);
    const safe = esc(txt);
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return safe.replace(re, '<mark>$1</mark>');
  }

  const CSS_ID = 'tpv2-styles-v1';
  const CSS = `
    .tpv2{font-family:inherit;color:var(--text,#111)}
    .tpv2 *{box-sizing:border-box}
    .tpv2-bucket{background:var(--card,#fff);border:1px solid var(--border,#e5e5ea);border-radius:12px;padding:16px;margin-bottom:14px}
    .tpv2-bucket-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}
    .tpv2-bucket-head h3{margin:0 0 2px;font-size:14px;font-weight:800;color:var(--text,#111)}
    .tpv2-bucket-head .sub{font-size:12px;color:var(--mute,#6e6e73);margin:0}
    .tpv2-bucket-head .count{font-size:11px;font-weight:800;background:rgba(255,27,141,.12);color:var(--magenta,#ff1b8d);padding:4px 10px;border-radius:999px;letter-spacing:.3px;white-space:nowrap}
    .tpv2-search{position:relative;margin-bottom:10px}
    .tpv2-search input{width:100%;background:var(--card2,#f5f5f7);border:1px solid var(--border,#e5e5ea);border-radius:9px;padding:10px 32px 10px 36px;font-size:14px;color:var(--text,#111);font:inherit}
    .tpv2-search input:focus{outline:0;border-color:var(--magenta,#ff1b8d)}
    .tpv2-search .ico{position:absolute;top:50%;left:12px;transform:translateY(-50%);color:var(--mute,#6e6e73);pointer-events:none;width:14px;height:14px}
    .tpv2-search .clear{position:absolute;top:50%;right:8px;transform:translateY(-50%);background:var(--card2,#f5f5f7);border:1px solid var(--border,#e5e5ea);color:var(--mute,#6e6e73);width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:12px;font-weight:700;padding:0;display:none;align-items:center;justify-content:center}
    .tpv2-search .clear.on{display:inline-flex}
    .tpv2-cats{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .tpv2-cat{background:var(--card2,#f5f5f7);border:1px solid var(--border,#e5e5ea);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;color:var(--mute,#6e6e73);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
    .tpv2-cat:hover{color:var(--text,#111)}
    .tpv2-cat.on{background:rgba(255,27,141,.12);border-color:var(--magenta,#ff1b8d);color:var(--magenta,#ff1b8d)}
    .tpv2-cat .n{font-size:10px;opacity:.7;font-weight:800}
    .tpv2-list{background:var(--card2,#f5f5f7);border:1px solid var(--border,#e5e5ea);border-radius:10px;max-height:300px;overflow-y:auto;margin-bottom:10px}
    .tpv2-group h4{margin:0;padding:8px 14px 4px;font-size:10px;font-weight:800;color:var(--mute,#6e6e73);text-transform:uppercase;letter-spacing:1.1px;position:sticky;top:0;background:var(--card2,#f5f5f7);z-index:1}
    .tpv2-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-left:2px solid transparent}
    .tpv2-item:hover{background:var(--card,#fff);border-left-color:var(--border,#e5e5ea)}
    .tpv2-item.sel{background:rgba(255,27,141,.1);border-left-color:var(--magenta,#ff1b8d)}
    .tpv2-item .mark{width:16px;height:16px;border-radius:4px;border:1.5px solid var(--border,#e5e5ea);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff}
    .tpv2-item.sel .mark{background:var(--magenta,#ff1b8d);border-color:var(--magenta,#ff1b8d)}
    .tpv2-item .mark svg{width:10px;height:10px;display:none}
    .tpv2-item.sel .mark svg{display:block}
    .tpv2-item .lbl{flex:1;font-size:13.5px;font-weight:600;color:var(--text,#111)}
    .tpv2-item .lbl mark{background:rgba(255,27,141,.2);color:var(--magenta,#ff1b8d);padding:0 2px;border-radius:2px;font-weight:700}
    .tpv2-item.ro{cursor:default}
    .tpv2-empty{padding:30px 20px;text-align:center;color:var(--mute,#6e6e73);font-size:12.5px}
    .tpv2-empty strong{display:block;color:var(--text,#111);font-size:13px;margin-bottom:6px}
    .tpv2-chips{display:flex;flex-wrap:wrap;gap:6px;min-height:28px}
    .tpv2-chip{display:inline-flex;align-items:center;gap:4px;padding:5px 6px 5px 11px;border-radius:999px;font-size:12px;font-weight:700;background:rgba(255,27,141,.14);border:1px solid var(--magenta,#ff1b8d);color:var(--magenta,#ff1b8d)}
    .tpv2-chip.demand{background:rgba(255,140,0,.14);border-color:var(--orange,#ff8c00);color:var(--orange,#ff8c00)}
    .tpv2-chip button{background:transparent;border:0;color:inherit;cursor:pointer;width:18px;height:18px;border-radius:50%;line-height:1;font-size:14px;padding:0;display:inline-flex;align-items:center;justify-content:center;opacity:.75}
    .tpv2-chip button:hover{opacity:1}
    .tpv2-chips-empty{color:var(--mute,#6e6e73);font-size:12px;font-style:italic;padding:4px 2px}
    .tpv2-status{font-size:11px;font-weight:700;margin-top:8px;color:var(--mute,#6e6e73)}
    .tpv2-status.ok{color:var(--ok,#22c55e)}
    .tpv2-status.warn{color:var(--orange,#ff8c00)}
  `;

  function ensureStyles() {
    if (document.getElementById(CSS_ID)) return;
    const st = document.createElement('style');
    st.id = CSS_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function TagPickerInstance(root, opts) {
    const state = {
      tags: Array.isArray(opts.tags) ? opts.tags.slice() : [],
      lang: opts.lang || 'es',
      ruedaType: opts.ruedaType || 'negocios',
      max: typeof opts.max === 'number' ? opts.max : 8,
      minPerBucket: typeof opts.minPerBucket === 'number' ? opts.minPerBucket : 1,
      readOnly: !!opts.readOnly,
      bucketLabels: opts.bucketLabels || null,
      onChange: typeof opts.onChange === 'function' ? opts.onChange : null,
      selected: {
        offer:  (opts.initialSelection && Array.isArray(opts.initialSelection.offer))  ? opts.initialSelection.offer.slice()  : [],
        demand: (opts.initialSelection && Array.isArray(opts.initialSelection.demand)) ? opts.initialSelection.demand.slice() : [],
      },
      // Per-bucket UI state
      ui: {
        offer:  { cat: 'all', query: '' },
        demand: { cat: 'all', query: '' },
      },
    };

    // ── Render skeleton (2 buckets) ────────────────────────────────────
    ensureStyles();
    root.classList.add('tpv2');
    root.innerHTML =
      '<div class="tpv2-bucket" data-bucket="offer"></div>' +
      '<div class="tpv2-bucket" data-bucket="demand"></div>';

    // ── Helpers ─────────────────────────────────────────────────────────
    function bucketTitles(kind) {
      if (state.bucketLabels) {
        if (kind === 'offer') return [state.bucketLabels.offerTitle || '', state.bucketLabels.offerHelp || ''];
        return [state.bucketLabels.demandTitle || '', state.bucketLabels.demandHelp || ''];
      }
      if (state.ruedaType === 'empleo') {
        return kind === 'offer'
          ? [t('reOfferT', state.lang), t('reOfferH', state.lang)]
          : [t('reDemT',   state.lang), t('reDemH',   state.lang)];
      }
      return kind === 'offer'
        ? [t('rnOfferT', state.lang), t('rnOfferH', state.lang)]
        : [t('rnDemT',   state.lang), t('rnDemH',   state.lang)];
    }

    function totalSelected() {
      return state.selected.offer.length + state.selected.demand.length;
    }

    function countsByCat(kind) {
      const used = new Set(state.selected[kind === 'offer' ? 'demand' : 'offer']); // ocultar en kind actual los que ya están en el otro bucket
      const pool = state.tags.filter(x => !used.has(x.id));
      const m = { all: pool.length };
      for (const x of pool) {
        const c = x.category || '—';
        m[c] = (m[c] || 0) + 1;
      }
      return { map: m, pool };
    }

    function filterPool(kind) {
      const { map, pool } = countsByCat(kind);
      const ui = state.ui[kind];
      const q = (ui.query || '').trim().toLowerCase();
      let items = pool;
      if (ui.cat !== 'all') items = items.filter(x => (x.category || '—') === ui.cat);
      if (q) {
        items = items.filter(x =>
          (pickLabel(x, state.lang) || '').toLowerCase().includes(q) ||
          (x.label    || '').toLowerCase().includes(q) ||
          (x.label_en || '').toLowerCase().includes(q) ||
          (x.label_pt || '').toLowerCase().includes(q) ||
          (x.slug     || '').toLowerCase().includes(q) ||
          (x.category || '').toLowerCase().includes(q)
        );
      }
      return { items, map };
    }

    function tagById(id) { return state.tags.find(x => x.id === id); }

    // ── Render per bucket ──────────────────────────────────────────────
    function renderBucket(kind) {
      const container = root.querySelector('[data-bucket="' + kind + '"]');
      if (!container) return;

      const [title, help] = bucketTitles(kind);
      const { items, map } = filterPool(kind);
      const selSet = new Set(state.selected[kind]);
      const ui = state.ui[kind];
      const q = ui.query.trim();

      // Groups by category
      const groups = {};
      for (const x of items) {
        const c = x.category || '—';
        (groups[c] = groups[c] || []).push(x);
      }
      const groupKeys = Object.keys(groups);

      // Build cat chips bar (only categories with count>0)
      const cats = ['all'].concat(Object.keys(map).filter(k => k !== 'all' && map[k] > 0));
      const catsHtml = cats.map(c => {
        const label = c === 'all' ? t('catAll', state.lang) : esc(c);
        return '<span class="tpv2-cat ' + (ui.cat === c ? 'on' : '') + '" data-cat="' + esc(c) + '">' +
               label + ' <span class="n">' + (map[c] || 0) + '</span></span>';
      }).join('');

      // Build list
      let listHtml = '';
      if (!groupKeys.length) {
        listHtml = '<div class="tpv2-empty"><strong>' + t('empty', state.lang) + '</strong>' +
                   t('emptyHint', state.lang) + '</div>';
      } else {
        listHtml = groupKeys.map(c => {
          const rows = groups[c];
          const ro = state.readOnly;
          return '<div class="tpv2-group">' +
                 '<h4>' + esc(c) + ' · ' + rows.length + '</h4>' +
                 rows.map(x => {
                   const selected = selSet.has(x.id);
                   return '<div class="tpv2-item ' + (selected ? 'sel' : '') + (ro ? ' ro' : '') + '" data-id="' + esc(x.id) + '">' +
                          '<span class="mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3,8 7,12 13,4"/></svg></span>' +
                          '<span class="lbl">' + highlight(pickLabel(x, state.lang), q) + '</span>' +
                          '</div>';
                 }).join('') +
                 '</div>';
        }).join('');
      }

      // Chips of selected
      const chipClass = kind === 'demand' ? 'tpv2-chip demand' : 'tpv2-chip';
      const chipsHtml = state.selected[kind].length
        ? state.selected[kind].map(id => {
            const x = tagById(id);
            if (!x) return '';
            const btn = state.readOnly ? '' : '<button type="button" data-remove="' + esc(id) + '" aria-label="remove">×</button>';
            return '<span class="' + chipClass + '">' + esc(pickLabel(x, state.lang)) + btn + '</span>';
          }).join('')
        : '<span class="tpv2-chips-empty">' + t('chipEmpty', state.lang) + '</span>';

      // Status line
      const total = totalSelected();
      const bucketLen = state.selected[kind].length;
      let statusCls = '';
      let statusText = bucketLen + ' / ' + state.max;
      if (total >= state.max) { statusCls = 'warn'; statusText = t('maxHit', state.lang); }
      else if (bucketLen >= state.minPerBucket) { statusCls = 'ok'; statusText = t('ok', state.lang) + ' · ' + bucketLen + ' / ' + state.max; }
      else { statusText = bucketLen + ' / ' + state.max + ' · ' + t('minMiss', state.lang); }

      container.innerHTML =
        '<div class="tpv2-bucket-head">' +
          '<div>' +
            '<h3>' + esc(title) + '</h3>' +
            '<p class="sub">' + esc(help) + '</p>' +
          '</div>' +
          '<span class="count">' + bucketLen + '</span>' +
        '</div>' +
        (state.readOnly ? '' :
          '<div class="tpv2-search">' +
            '<svg class="ico" viewBox="0 0 256 256" fill="currentColor"><path d="M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"/></svg>' +
            '<input type="text" placeholder="' + esc(t('searchPh', state.lang)) + '" value="' + esc(ui.query) + '" data-search>' +
            '<button type="button" class="clear ' + (ui.query ? 'on' : '') + '" data-clear>×</button>' +
          '</div>' +
          '<div class="tpv2-cats">' + catsHtml + '</div>' +
          '<div class="tpv2-list" data-list>' + listHtml + '</div>'
        ) +
        '<div class="tpv2-chips">' + chipsHtml + '</div>' +
        (state.readOnly ? '' : '<div class="tpv2-status ' + statusCls + '">' + statusText + '</div>');

      bindBucket(kind, container);
    }

    function bindBucket(kind, container) {
      if (state.readOnly) {
        // En readOnly, los chips no tienen botón, y la lista no reacciona
      } else {
        const inp = container.querySelector('[data-search]');
        if (inp) {
          inp.addEventListener('input', (e) => {
            state.ui[kind].query = e.target.value;
            container.querySelector('[data-clear]').classList.toggle('on', !!e.target.value);
            // Re-render list + cats (counts don't change but cat 'on' highlight could reset)
            renderListOnly(kind, container);
          });
          inp.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ state.ui[kind].query=''; inp.value=''; renderListOnly(kind, container); container.querySelector('[data-clear]').classList.remove('on'); } });
        }
        const clearBtn = container.querySelector('[data-clear]');
        if (clearBtn) clearBtn.addEventListener('click', () => {
          state.ui[kind].query = '';
          const inp = container.querySelector('[data-search]');
          if (inp) inp.value = '';
          clearBtn.classList.remove('on');
          renderListOnly(kind, container);
        });
        container.querySelectorAll('.tpv2-cat').forEach(el => {
          el.addEventListener('click', () => {
            state.ui[kind].cat = el.getAttribute('data-cat');
            container.querySelectorAll('.tpv2-cat').forEach(e => e.classList.toggle('on', e === el));
            renderListOnly(kind, container);
          });
        });
        container.querySelectorAll('.tpv2-item').forEach(el => {
          el.addEventListener('click', () => toggle(kind, el.getAttribute('data-id')));
        });
      }
      container.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(kind, btn.getAttribute('data-remove')); });
      });
    }

    function renderListOnly(kind, container) {
      // Lighter re-render: only the list area and chip count/status
      const { items } = filterPool(kind);
      const selSet = new Set(state.selected[kind]);
      const q = state.ui[kind].query.trim();
      const groups = {};
      for (const x of items) { const c = x.category || '—'; (groups[c] = groups[c] || []).push(x); }
      const groupKeys = Object.keys(groups);
      const listEl = container.querySelector('[data-list]');
      if (!listEl) return renderBucket(kind);
      if (!groupKeys.length) {
        listEl.innerHTML = '<div class="tpv2-empty"><strong>' + t('empty', state.lang) + '</strong>' + t('emptyHint', state.lang) + '</div>';
      } else {
        const ro = state.readOnly;
        listEl.innerHTML = groupKeys.map(c => '<div class="tpv2-group"><h4>' + esc(c) + ' · ' + groups[c].length + '</h4>' +
          groups[c].map(x => {
            const selected = selSet.has(x.id);
            return '<div class="tpv2-item ' + (selected ? 'sel' : '') + (ro ? ' ro' : '') + '" data-id="' + esc(x.id) + '">' +
                   '<span class="mark"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3,8 7,12 13,4"/></svg></span>' +
                   '<span class="lbl">' + highlight(pickLabel(x, state.lang), q) + '</span></div>';
          }).join('') + '</div>').join('');
        listEl.querySelectorAll('.tpv2-item').forEach(el => {
          el.addEventListener('click', () => toggle(kind, el.getAttribute('data-id')));
        });
      }
    }

    function toggle(kind, id) {
      if (state.readOnly) return;
      const bucket = state.selected[kind];
      const i = bucket.indexOf(id);
      if (i >= 0) {
        bucket.splice(i, 1);
      } else {
        if (totalSelected() >= state.max) {
          flashMax(kind);
          return;
        }
        bucket.push(id);
      }
      if (state.onChange) state.onChange(getSelection());
      renderBucket(kind);
      renderBucket(kind === 'offer' ? 'demand' : 'offer'); // el otro bucket cambia conteos
    }

    let flashTimer = null;
    function flashMax(kind) {
      const container = root.querySelector('[data-bucket="' + kind + '"]');
      if (!container) return;
      const st = container.querySelector('.tpv2-status');
      if (!st) return;
      st.textContent = t('maxHit', state.lang);
      st.className = 'tpv2-status warn';
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => renderBucket(kind), 1800);
    }

    function getSelection() {
      return { offer: state.selected.offer.slice(), demand: state.selected.demand.slice() };
    }

    function setSelection(sel) {
      state.selected.offer  = Array.isArray(sel && sel.offer)  ? sel.offer.slice()  : [];
      state.selected.demand = Array.isArray(sel && sel.demand) ? sel.demand.slice() : [];
      renderBucket('offer'); renderBucket('demand');
    }

    function setLang(l) {
      if (!['es','en','pt'].includes(l)) return;
      state.lang = l;
      renderBucket('offer'); renderBucket('demand');
    }

    function setReadOnly(ro) {
      state.readOnly = !!ro;
      renderBucket('offer'); renderBucket('demand');
    }

    function setTags(tags) {
      state.tags = Array.isArray(tags) ? tags.slice() : [];
      renderBucket('offer'); renderBucket('demand');
    }

    function destroy() {
      root.innerHTML = '';
      root.classList.remove('tpv2');
    }

    renderBucket('offer');
    renderBucket('demand');

    return { setLang, setReadOnly, setSelection, setTags, getSelection, destroy };
  }

  const TagPickerV2 = {
    mount: function (selectorOrEl, opts) {
      const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
      if (!el) throw new Error('tag-picker-v2: mount target not found');
      return new TagPickerInstance(el, opts || {});
    }
  };

  if (typeof module === 'object' && module.exports) module.exports = TagPickerV2;
  else global.TagPickerV2 = TagPickerV2;
})(typeof window !== 'undefined' ? window : this);
