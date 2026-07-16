/**
 * public/js/api.js — Bom Beef Sistema de Gestão
 * AR Boutique de Carnes LTDA — CNPJ 46.237.080/0001-02
 * Uso exclusivo. Reprodução proibida.
 */
(function(w) {
  'use strict';

  // Detecta se está rodando dentro de um iframe
  const _emIframe = w.self !== w.top;

  // ── Token ──────────────────────────────────────────────────────────────────
  function getToken() {
    return sessionStorage.getItem('bb_token') || localStorage.getItem('bb_token') || '';
  }
  function setToken(tk) {
    if (tk) sessionStorage.setItem('bb_token', tk);
  }

  // ── Tratamento de 401 ─────────────────────────────────────────────────────
  // CRÍTICO: dentro de iframe NUNCA redirecionar com location.href
  // Só faz logout se o módulo já estava inicializado (_bbReady = true).
  // Se ainda está na fase de inicialização, apenas descarta o token expirado
  // e pede um novo ao portal — evita o bug de "precisa fazer login duas vezes"
  // causado por token residual expirado no sessionStorage de sessão anterior.
  // Flag global para evitar múltiplos 401 simultâneos
  let _logoutEmAndamento = false;

  function handle401() {
    if (_logoutEmAndamento) return; // já está tratando
    sessionStorage.removeItem('bb_token');
    localStorage.removeItem('bb_token');
    if (_emIframe) {
      if (_bbReady) {
        // Sessão expirou durante uso normal → logout único
        _logoutEmAndamento = true;
        try { w.parent.postMessage({ type: 'bb_logout' }, '*'); } catch (_) {}
      } else {
        // Token expirado na inicialização → pede token fresco
        try { w.parent.postMessage({ type: 'bb_request_auth' }, '*'); } catch (_) {}
      }
    } else {
      w.location.href = '/';
    }
  }

  // ── Renovação de token ────────────────────────────────────────────────────
  let _refreshing = false;
  let _refreshProm = null;

  async function tryRefresh() {
    if (!_refreshing) {
      _refreshing = true;
      _refreshProm = fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() }
      }).then(r => r.json()).catch(() => ({ ok: false }))
        .finally(() => { _refreshing = false; });
    }
    return _refreshProm;
  }

  // ── apiFetch ───────────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const makeHeaders = () => ({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
      ...(opts.headers || {}),
    });
    let res;
    try {
      res = await fetch(path, { cache: 'no-store', ...opts, headers: makeHeaders() });
    } catch (_) {
      return { ok: false, erro: 'Sem conexão com o servidor' };
    }
    if (res.status === 401) {
      // Tenta renovar antes de deslogar
      try {
        const ref = await tryRefresh();
        if (ref && ref.ok && ref.token) {
          setToken(ref.token);
          // Reexecuta com novo token
          res = await fetch(path, { cache: 'no-store', ...opts, headers: makeHeaders() });
          if (res.status !== 401) {
            try { return await res.json(); }
            catch(_) { return { ok: false, erro: 'Resposta inválida' }; }
          }
        }
      } catch(_) {}
      handle401();
      throw new Error('Sessão expirada');
    }
    try { return await res.json(); }
    catch (_) { return { ok: false, erro: 'Resposta inválida do servidor' }; }
  }

  // ── apiUpload ──────────────────────────────────────────────────────────────
  async function apiUpload(path, formData) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() },
        body: formData,
      });
    } catch (_) { return { ok: false, erro: 'Sem conexão com o servidor' }; }
    if (res.status === 401) {
      try {
        const ref = await tryRefresh();
        if (ref && ref.ok && ref.token) {
          setToken(ref.token);
          res = await fetch(path, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + ref.token },
            body: formData,
          });
          if (res.status !== 401) {
            try { return await res.json(); } catch(_) { return { ok:false }; }
          }
        }
      } catch(_) {}
      handle401();
      throw new Error('Sessão expirada');
    }
    try { return await res.json(); }
    catch (_) { return { ok: false, erro: 'Resposta inválida do servidor' }; }
  }

  // ── Helpers de API ─────────────────────────────────────────────────────────
  const api = {
    token:  getToken,
    setToken,
    get:    (path)       => apiFetch(path),
    post:   (path, body) => apiFetch(path, { method: 'POST',  body: JSON.stringify(body) }),
    put:    (path, body) => apiFetch(path, { method: 'PUT',   body: JSON.stringify(body) }),
    patch:  (path, body) => apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (path, body) => apiFetch(path, { method: 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}) }),
    upload: apiUpload,
  };

  // ── Formatadores ───────────────────────────────────────────────────────────
  const fmt = {
    brl: v => 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    n:   v => parseInt(v || 0).toLocaleString('pt-BR'),
    pct: v => parseFloat(v || 0).toFixed(1) + '%',
    date: iso => {
      if (!iso) return '—';
      const s = String(iso).slice(0, 10);
      // Proteção: se não tem o formato de data ISO (YYYY-MM-DD), é dado corrompido
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '⚠️ data inválida';
      const [y, m, d] = s.split('-');
      return `${d}/${m}/${y}`;
    },
    dateInput: iso => iso ? String(iso).slice(0, 10) : '',
    mesAtual: () => {
      const d = new Date();
      return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    },
    mesFromDate: iso => {
      if (!iso) return '';
      const s = String(iso).slice(0, 10);
      return s.slice(5, 7) + '/' + s.slice(0, 4);
    },
  };

  // ── Toast ──────────────────────────────────────────────────────────────────
  let _toastTimer;
  function toast(msg, ms = 2500) {
    let el = document.getElementById('bb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bb-toast';
      el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(60px);background:#333;color:#fff;padding:9px 20px;border-radius:9px;font-size:13px;z-index:9999;transition:transform .3s;pointer-events:none;font-family:DM Sans,sans-serif;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.transform = 'translateX(-50%) translateY(60px)'; }, ms);
  }

  // ── Inicialização com token ────────────────────────────────────────────────
  let _bbReady = false;

  function _dispararReady(usuario) {
    if (_bbReady) return;
    _bbReady = true;
    if (typeof w.onBBReady === 'function') {
      try { w.onBBReady(usuario); } catch(e) { console.error('[BB] onBBReady:', e); }
    }
  }

  // Escuta token enviado pelo portal pai
  window.addEventListener('message', e => {
    if (e.data?.type === 'bb_token' && e.data.token) {
      setToken(e.data.token);
      w.__bbUsuario = e.data.usuario;
      _dispararReady(e.data.usuario);
    }
  });

  // Token já existe no storage (recarga de página)
  if (getToken()) {
    setTimeout(() => _dispararReady(w.__bbUsuario), 50);
  } else if (_emIframe) {
    // Dentro de iframe sem token — pede ao portal pai
    // Retry em 500ms, 1.5s e 4s para cobrir mobile com rede lenta
    function _pedirToken() {
      try { w.parent.postMessage({ type: 'bb_request_auth' }, '*'); } catch (_) {}
    }
    _pedirToken();
    [500, 1500, 4000].forEach(d => setTimeout(() => {
      if (_bbReady) return;
      if (getToken()) _dispararReady(w.__bbUsuario);
      else _pedirToken();
    }, d));
  }

  // ── Expõe globalmente ──────────────────────────────────────────────────────
  w.BB = { api, fmt, toast };

})(window);
