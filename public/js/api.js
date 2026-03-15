/**
 * public/js/api.js
 * Helper de comunicação com a API REST — compartilhado por todos os módulos.
 * Deve ser incluído como <script src="/js/api.js"></script> em cada página.
 */

(function(w) {
  'use strict';

  // ── Token ──────────────────────────────────────────────────────────────────
  function getToken() {
    return sessionStorage.getItem('bb_token') || localStorage.getItem('bb_token') || '';
  }

  function setToken(tk) {
    sessionStorage.setItem('bb_token', tk);
  }

  // ── Fetch com auth ─────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
      ...(opts.headers || {}),
    };

    const res = await fetch(path, { ...opts, headers });

    if (res.status === 401) {
      // Token expirado — notifica o pai e redireciona
      sessionStorage.removeItem('bb_token');
      try { window.parent.postMessage({ type: 'bb_logout' }, '*'); } catch (_) {}
      window.location.href = '/';
      throw new Error('Sessão expirada');
    }

    const data = await res.json();
    return data;
  }

  // ── Upload multipart ───────────────────────────────────────────────────────
  async function apiUpload(path, formData) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + getToken() },
      body: formData,
    });
    if (res.status === 401) {
      sessionStorage.removeItem('bb_token');
      try { window.parent.postMessage({ type: 'bb_logout' }, '*'); } catch (_) {}
      window.location.href = '/';
      throw new Error('Sessão expirada');
    }
    return res.json();
  }

  // ── GET, POST, PUT, DELETE helpers ─────────────────────────────────────────
  const api = {
    token: getToken,
    setToken,
    get:    (path)         => apiFetch(path),
    post:   (path, body)   => apiFetch(path, { method: 'POST',   body: JSON.stringify(body) }),
    put:    (path, body)   => apiFetch(path, { method: 'PUT',    body: JSON.stringify(body) }),
    delete: (path)         => apiFetch(path, { method: 'DELETE' }),
    upload: apiUpload,
  };

  // ── Formatadores ───────────────────────────────────────────────────────────
  const fmt = {
    brl: v => 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    n:   v => parseInt(v || 0).toLocaleString('pt-BR'),
    pct: v => parseFloat(v || 0).toFixed(1) + '%',
    date: iso => {
      if (!iso) return '—';
      const [y, m, d] = String(iso).slice(0, 10).split('-');
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
      el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%) translateY(60px);background:#333;color:#fff;padding:9px 20px;border-radius:9px;font-size:13px;z-index:9999;transition:transform .3s;pointer-events:none;font-family:DM Sans,sans-serif;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.transform = 'translateX(-50%) translateY(60px)'; }, ms);
  }

  // ── Inicialização: recebe token do parent (iframe) ─────────────────────────
  window.addEventListener('message', e => {
    if (e.data?.type === 'bb_token' && e.data.token) {
      setToken(e.data.token);
      w.__bbUsuario = e.data.usuario;
      if (typeof w.onBBReady === 'function') w.onBBReady(e.data.usuario);
    }
  });

  // Também tenta pegar o token já existente
  if (getToken() && typeof w.onBBReady === 'function') {
    setTimeout(() => w.onBBReady(w.__bbUsuario), 100);
  }

  // ── Expõe globalmente ──────────────────────────────────────────────────────
  w.BB = { api, fmt, toast };

})(window);
