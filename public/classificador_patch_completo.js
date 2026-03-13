/**
 * Patch completo do classificador:
 * - cria salvarNoBanco() se não existir
 * - mantém o botão saveSession() salvando no banco antes do JSON local
 * - auto-save a cada 10 segundos, somente quando houver mudanças
 * - tentativa de salvar ao fechar a página
 *
 * Uso:
 * 1) Salve este arquivo como public/classificador_patch_completo.js
 * 2) No final do classificador_bom_beef_v5.html, antes de </body>, adicione:
 *    <script src="classificador_patch_completo.js"></script>
 */
(function () {
  const AUTOSAVE_MS = 10000;
  let __bbSessaoId = null;
  let __lastFingerprint = "";
  let __autosaveTimer = null;
  let __autosaveRunning = false;

  function safeToast(msg) {
    try {
      if (typeof toast === "function") toast(msg, 1800);
      else console.log(msg);
    } catch (_) {
      console.log(msg);
    }
  }

  function inferMesRef() {
    try {
      const filter = document.getElementById("filter-month");
      if (filter && filter.value && filter.value !== "ALL") return String(filter.value);

      if (Array.isArray(window.transactions) && window.transactions.length) {
        const meses = [...new Set(window.transactions.map(t => t && (t.mesCaixa || t.mes)).filter(Boolean))];
        if (meses.length) return String(meses.sort().slice(-1)[0]);
      }
    } catch (_) {}
    const d = new Date();
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }

  function buildSessionPayload() {
    const customCats = {};
    try {
      if (window.DRE_CATEGORIES && window.DEFAULT_CATS) {
        for (const [gk, g] of Object.entries(window.DRE_CATEGORIES)) {
          const extras = (g.subs || []).filter(s => !window.DEFAULT_CATS.has(s));
          if (extras.length) customCats[gk] = extras;
        }
      }
    } catch (_) {}

    return {
      _schema: 2,
      _savedAt: new Date().toISOString(),
      _version: "Bom Beef Classificador",
      globalId: window.globalId || 0,
      loadedFiles: window.loadedFiles || [],
      transactions: window.transactions || [],
      employees: window.employees || [],
      customCats,
      supplierCatMemory: window.supplierCatMemory || {}
    };
  }

  function currentFingerprint() {
    try {
      return JSON.stringify({
        total: Array.isArray(window.transactions) ? window.transactions.length : 0,
        files: window.loadedFiles || [],
        employees: Array.isArray(window.employees) ? window.employees.length : 0,
        tx: (window.transactions || []).map(t => [
          t.id, t.categoria, t.ignorar, t.mes, t.mesCaixa,
          t.valor, t.lancamento, t.parcela, t.fonte
        ])
      });
    } catch (_) {
      return String(Date.now());
    }
  }

  async function salvarNoBancoPatch(silent = false) {
    const token = sessionStorage.getItem("bb_token");
    if (!token) throw new Error("Token não encontrado.");

    const payload = {
      sessao_id: __bbSessaoId,
      mes_ref: inferMesRef(),
      descricao: `Sessão classificador - ${(window.transactions || []).length} lançamentos`,
      dados_json: buildSessionPayload()
    };

    const resp = await fetch("/api/classificador/salvar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error(data.erro || `HTTP ${resp.status}`);
    }

    __bbSessaoId = data.sessao_id || __bbSessaoId;
    if (!silent) safeToast(`💾 Sessão salva no banco (ID ${__bbSessaoId})`);
    return data;
  }

  if (typeof window.salvarNoBanco !== "function") {
    window.salvarNoBanco = salvarNoBancoPatch;
  }

  if (typeof window.saveSession === "function" && !window.saveSession.__bbWrapped) {
    const _originalSaveSession = window.saveSession;
    const wrapped = async function (...args) {
      try {
        if (Array.isArray(window.transactions) && window.transactions.length) {
          await window.salvarNoBanco(true);
        }
      } catch (e) {
        console.error("[classificador] erro ao salvar no banco antes do download local:", e);
      }
      return _originalSaveSession.apply(this, args);
    };
    wrapped.__bbWrapped = true;
    window.saveSession = wrapped;
  }

  async function autosaveTick() {
    if (__autosaveRunning) return;
    try {
      if (!Array.isArray(window.transactions) || window.transactions.length === 0) return;

      const fp = currentFingerprint();
      if (fp === __lastFingerprint) return;

      __autosaveRunning = true;
      await window.salvarNoBanco(true);
      __lastFingerprint = fp;
      console.log("[classificador] auto-save OK");
    } catch (e) {
      console.error("[classificador] auto-save falhou:", e);
    } finally {
      __autosaveRunning = false;
    }
  }

  function startAutosave() {
    if (__autosaveTimer) clearInterval(__autosaveTimer);
    __autosaveTimer = setInterval(autosaveTick, AUTOSAVE_MS);
    setTimeout(autosaveTick, 3000);
    console.log("[classificador] auto-save 10s habilitado");
  }

  window.addEventListener("beforeunload", function () {
    try {
      if (Array.isArray(window.transactions) && window.transactions.length) {
        window.salvarNoBanco(true).catch(() => {});
      }
    } catch (_) {}
  });

  startAutosave();
})();
