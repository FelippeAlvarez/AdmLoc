'use strict';
/*
  Armazenamento na nuvem: Dropbox ou Google Drive, numa pasta compartilhada pela equipe.
  Cada pessoa entra com a própria conta; a pasta é compartilhada pelo dono com os demais.
  As chaves dos aplicativos ficam em nuvem-config.js (ou são informadas na tela de conexão).
*/

const chavesNuvem = () => ({
  dropbox: (window.NUVEM?.dropboxAppKey || localStorage.getItem('cl-dbx-chave') || '').trim(),
  google: (window.NUVEM?.googleClientId || localStorage.getItem('cl-gdr-cliente') || '').trim(),
});
const urlRetorno = () => location.origin + location.pathname;
const nuvemDisponivel = () => window.isSecureContext && !!window.crypto?.subtle;

function b64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function textoAleatorio(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
// O cabeçalho Dropbox-API-Arg só aceita ASCII: acentos vão como \uXXXX
const jsonAscii = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/* ================= Dropbox ================= */
const NuvemDropbox = {
  pasta: '',
  _token: null,
  _expira: 0,

  temAcesso() { return !!localStorage.getItem('cl-dbx-refresh'); },

  // Login com OAuth 2 (PKCE): vai ao Dropbox e volta para esta página com ?code=...
  async entrar() {
    const chave = chavesNuvem().dropbox;
    if (!chave) throw new Error('Informe a chave do aplicativo Dropbox (App key).');
    const verificador = textoAleatorio(48);
    const desafio = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador))));
    sessionStorage.setItem('cl-dbx-verif', verificador);
    location.href = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: chave, response_type: 'code', code_challenge: desafio, code_challenge_method: 'S256',
      token_access_type: 'offline', redirect_uri: urlRetorno(), state: 'dropbox',
    });
  },

  async concluirEntrada(codigo) {
    const r = await buscarNuvem('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        code: codigo, grant_type: 'authorization_code', code_verifier: sessionStorage.getItem('cl-dbx-verif') || '',
        client_id: chavesNuvem().dropbox, redirect_uri: urlRetorno(),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Dropbox: ' + (j.error_description || j.error || 'erro ' + r.status));
    localStorage.setItem('cl-dbx-refresh', j.refresh_token);
    this._token = j.access_token;
    this._expira = Date.now() + (j.expires_in - 120) * 1000;
  },

  async token() {
    if (this._token && Date.now() < this._expira) return this._token;
    const r = await buscarNuvem('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: localStorage.getItem('cl-dbx-refresh') || '', client_id: chavesNuvem().dropbox }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') localStorage.removeItem('cl-dbx-refresh');
      throw new Error('Dropbox: o acesso expirou ou foi revogado. Entre novamente.');
    }
    this._token = j.access_token;
    this._expira = Date.now() + (j.expires_in - 120) * 1000;
    return this._token;
  },

  caminho(c) { return this.pasta.replace(/\/+$/, '') + '/' + c; },

  // Confere a pasta dos dados; se ainda não existir (primeira conexão), cria
  async verificarPasta(pasta) {
    const api = (rota, corpo) => this.token().then(t => buscarNuvem('https://api.dropboxapi.com/2/files/' + rota, {
      method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    }));
    let r = await api('get_metadata', { path: pasta });
    if (r.status === 409) {
      r = await api('create_folder_v2', { path: pasta, autorename: false });
      if (!r.ok) throw new Error(`Não foi possível criar a pasta "${pasta}" no Dropbox (erro ${r.status}).`);
      return 'criada';
    }
    if (!r.ok) throw new Error('Dropbox: erro ' + r.status + ' ao abrir a pasta.');
    const j = await r.json();
    if (j['.tag'] !== 'folder') throw new Error(`"${pasta}" não é uma pasta.`);
    return 'existente';
  },

  /*
    Trava contra gravações simultâneas: cada leitura guarda a revisão ("rev") do arquivo no Dropbox.
    A gravação seguinte só é aceita se o arquivo ainda estiver naquela revisão (ou, se ele não existia,
    se continuar não existindo). Se outra pessoa gravou no meio, o Dropbox recusa e o app relê e refaz.
  */
  _revs: new Map(),

  async ler(c) {
    const r = await buscarNuvem('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await this.token(), 'Dropbox-API-Arg': jsonAscii({ path: this.caminho(c) }) },
    });
    if (r.status === 409) {
      const t = await r.text();
      if (t.includes('not_found')) { this._revs.set(c, null); return null; }
      throw new Error('Dropbox: ' + t.slice(0, 200));
    }
    if (!r.ok) throw new Error(`Dropbox: erro ${r.status} ao ler ${c}.`);
    try { this._revs.set(c, JSON.parse(r.headers.get('Dropbox-API-Result') || '{}').rev || undefined); } catch { this._revs.delete(c); }
    return await r.text();
  },

  async gravar(c, texto) {
    // Revisão conhecida: só grava sobre ela. Arquivo lido como inexistente: só cria se continuar inexistente.
    // Sem leitura prévia (cópias de segurança, importação): grava por cima.
    const rev = this._revs.get(c);
    const modo = rev ? { '.tag': 'update', update: rev } : this._revs.has(c) && rev === null ? 'add' : 'overwrite';
    const r = await buscarNuvem('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': jsonAscii({ path: this.caminho(c), mode: modo, autorename: false, strict_conflict: true, mute: true }),
      },
      body: new TextEncoder().encode(texto),
    });
    if (r.status === 409) {
      const t = await r.text();
      this._revs.delete(c);
      if (t.includes('conflict')) throw new ErroCorrida(c);
      throw new Error(`Dropbox: não foi possível gravar ${c}: ${t.slice(0, 200)}`);
    }
    if (!r.ok) throw new Error(`Dropbox: erro ${r.status} ao gravar ${c}: ${(await r.text()).slice(0, 200)}`);
    try { this._revs.set(c, (await r.json()).rev); } catch { this._revs.delete(c); }
  },

  sair() { localStorage.removeItem('cl-dbx-refresh'); this._token = null; },
};

/* ================= Google Drive ================= */
const PASTA_GOOGLE = 'application/vnd.google-apps.folder';

const NuvemGoogle = {
  pastaId: '',
  _token: null,
  _expira: 0,
  _ids: new Map(),

  async _carregarLogin() {
    if (window.google?.accounts?.oauth2) return;
    await new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = ok;
      s.onerror = () => falha(new Error('Não foi possível carregar o login do Google. Verifique a internet.'));
      document.head.appendChild(s);
    });
  },

  // Precisa ser chamado a partir de um clique (abre a janela de login do Google)
  async entrar() {
    await this._carregarLogin();
    const cliente = chavesNuvem().google;
    if (!cliente) throw new Error('Informe o ID do cliente OAuth do Google.');
    await new Promise((ok, falha) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: cliente,
        scope: 'https://www.googleapis.com/auth/drive',
        callback: resp => {
          if (resp.error) return falha(new Error('Google: ' + resp.error));
          this._token = resp.access_token;
          this._expira = Date.now() + (Number(resp.expires_in) - 120) * 1000;
          localStorage.setItem('cl-gdr-ok', '1');
          ok();
        },
        error_callback: e => falha(new Error(e.type === 'popup_closed' ? 'A janela de login do Google foi fechada.' : 'Google: ' + (e.message || e.type))),
      });
      tc.requestAccessToken({ prompt: localStorage.getItem('cl-gdr-ok') ? '' : 'consent' });
    });
  },

  temSessao() { return !!this._token && Date.now() < this._expira; },

  async token() {
    if (this.temSessao()) return this._token;
    throw new Error('A sessão do Google expirou. Clique em “Google Drive” no alto da tela para entrar novamente.');
  },

  async api(url, opcoes = {}) {
    const r = await buscarNuvem(url, { ...opcoes, headers: { Authorization: 'Bearer ' + await this.token(), ...(opcoes.headers || {}) } });
    if (r.status === 401) { this._token = null; return this.token(); }
    if (!r.ok) throw new Error(`Google Drive: erro ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  },

  extrairId(link) {
    const s = String(link || '').trim();
    return (s.match(/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/) || [null, s.match(/^[\w-]{10,}$/) ? s : ''])[1];
  },

  async verificarPasta(id) {
    const r = await this.api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`).catch(e => {
      throw new Error(String(e.message).includes('404') ? 'Pasta não encontrada, ou você não tem acesso a ela. Confira o link e se a pasta foi compartilhada com a sua conta.' : e.message);
    });
    const j = await r.json();
    if (j.mimeType !== PASTA_GOOGLE) throw new Error('O link informado não é de uma pasta.');
    return j.name;
  },

  async _buscar(nome, paiId, ehPasta) {
    const q = `name='${nome.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${paiId}' in parents and trashed=false and mimeType${ehPasta ? '=' : '!='}'${PASTA_GOOGLE}'`;
    const r = await this.api('https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
      q, fields: 'files(id)', orderBy: 'modifiedTime desc', pageSize: '5', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
    }));
    return (await r.json()).files?.[0]?.id || null;
  },

  async _criarPasta(nome, paiId) {
    const r = await this.api('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nome, mimeType: PASTA_GOOGLE, parents: [paiId] }),
    });
    return (await r.json()).id;
  },

  // Converte "extratos/abc.json" no id do arquivo (criando as subpastas se necessário)
  async _id(caminho, criarPastas) {
    if (this._ids.has(caminho)) return { pai: null, id: this._ids.get(caminho) };
    const partes = caminho.split('/');
    let pai = this.pastaId, acum = '';
    for (let i = 0; i < partes.length; i++) {
      const ultimo = i === partes.length - 1;
      acum = acum ? acum + '/' + partes[i] : partes[i];
      let id = this._ids.get(acum) || await this._buscar(partes[i], pai, !ultimo);
      if (!id && !ultimo && criarPastas) id = await this._criarPasta(partes[i], pai);
      if (!id) return { pai: ultimo ? pai : null, id: null };
      this._ids.set(acum, id);
      pai = id;
    }
    return { pai: null, id: pai };
  },

  async ler(c) {
    const { id } = await this._id(c, false);
    if (!id) return null;
    const r = await buscarNuvem(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + await this.token() } });
    if (r.status === 404) { this._ids.delete(c); return null; }
    if (r.status === 401) { this._token = null; await this.token(); }
    if (!r.ok) throw new Error(`Google Drive: erro ${r.status} ao ler ${c}.`);
    return await r.text();
  },

  async gravar(c, texto) {
    const { id, pai } = await this._id(c, true);
    const tipo = c.endsWith('.json') ? 'application/json' : 'text/plain';
    if (id) {
      await this.api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&supportsAllDrives=true`, {
        method: 'PATCH', headers: { 'Content-Type': tipo }, body: texto,
      });
      return;
    }
    const limite = 'cl' + textoAleatorio(12);
    const nome = c.split('/').pop();
    const corpo = `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: nome, parents: [pai], mimeType: tipo })}\r\n`
      + `--${limite}\r\nContent-Type: ${tipo}; charset=UTF-8\r\n\r\n${texto}\r\n--${limite}--`;
    const r = await this.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id', {
      method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + limite }, body: corpo,
    });
    this._ids.set(c, (await r.json()).id);
  },

  sair() {
    if (this._token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this._token, () => {});
    this._token = null;
    localStorage.removeItem('cl-gdr-ok');
  },
};
