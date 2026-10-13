'use strict';
/*
  Usuários e acesso. Perfis: "admin" (administrador) e "usuario".
  - Modo servidor: o servidor confere as senhas e bloqueia o que não for permitido.
  - Modos pasta, nuvem e local: as senhas ficam em usuarios.json (PBKDF2-SHA256, mesmo formato do servidor)
    e são conferidas pelo aplicativo.
*/

class ErroSessao extends Error {
  constructor(m) { super(m || 'Sua sessão expirou. Entre novamente.'); this.sessao = true; }
}

const b64ParaBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const bytesParaB64 = b => btoa(String.fromCharCode(...b));
const ITERACOES = 100000;

function validarLogin(login) {
  if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw new Error('O login deve ter de 3 a 30 caracteres: letras sem acento, números, ponto, hífen ou sublinhado.');
}
function validarSenha(s) { if (!s || s.length < 6) throw new Error('A senha deve ter pelo menos 6 caracteres.'); }

const Auth = {
  usuario: null,
  token: '',

  ehAdmin() { return this.usuario?.perfil === 'admin'; },
  servidor() { return Armaz.modo === 'servidor'; },

  _guardar(lembrar) {
    const d = JSON.stringify({ usuario: this.usuario, token: this.token, modo: Armaz.modo });
    sessionStorage.setItem('cl-sessao', d);
    if (lembrar) localStorage.setItem('cl-sessao', d); else localStorage.removeItem('cl-sessao');
  },
  _guardado() {
    try { return JSON.parse(sessionStorage.getItem('cl-sessao') || localStorage.getItem('cl-sessao') || 'null'); } catch { return null; }
  },
  sair() {
    sessionStorage.removeItem('cl-sessao');
    localStorage.removeItem('cl-sessao');
    this.usuario = null;
    this.token = '';
  },

  /* ---------- servidor ---------- */
  async _api(rota, metodo = 'GET', corpo) {
    const r = await buscar('api/' + rota, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && rota !== 'login') throw new ErroSessao();
    if (!r.ok) throw new Error(j.erro || `Erro ${r.status} no servidor.`);
    return j;
  },

  /* ---------- arquivo usuarios.json (pasta, nuvem, local) ---------- */
  async _ler() { return (await lerJSON('usuarios.json', { usuarios: {} })).usuarios || {}; },
  async _gravar(u) {
    await comTrava(async () => {
      const atual = await lerJSON('usuarios.json', { usuarios: {} });
      atual.usuarios = u;
      atual.atualizadoEm = new Date().toISOString();
      await Armaz.gravar('usuarios.json', JSON.stringify(atual, null, 1));
    });
  },
  _cripto() {
    if (!window.crypto?.subtle) throw new Error('Este navegador não permite conferir senhas neste endereço. Abra o aplicativo por um endereço seguro (https) ou pelo servidor.');
  },
  async _hash(senha, sal, iter) {
    this._cripto();
    const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(senha), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ParaBytes(sal), iterations: iter }, chave, 256);
    return bytesParaB64(new Uint8Array(bits));
  },
  async _novaSenha(senha) {
    this._cripto();
    const sal = bytesParaB64(crypto.getRandomValues(new Uint8Array(16)));
    return { sal, iter: ITERACOES, hash: await this._hash(senha, sal, ITERACOES) };
  },
  _admins(u) { return Object.values(u).filter(r => r.perfil === 'admin' && r.ativo).length; },
  _lista(u) { return Object.keys(u).sort().map(login => ({ login, nome: u[login].nome, perfil: u[login].perfil, ativo: !!u[login].ativo })); },

  /* ---------- operações ---------- */
  async temUsuarios() {
    if (this.servidor()) return !!Armaz.infoServidor?.usuarios;
    return Object.keys(await this._ler()).length > 0;
  },

  podeCriarPrimeiroAdmin() { return !this.servidor() || !!Armaz.infoServidor?.local; },

  async criarPrimeiroAdmin({ login, nome, senha }) {
    login = login.trim().toLowerCase();
    validarLogin(login); validarSenha(senha);
    if (!nome.trim()) throw new Error('Informe o nome.');
    if (this.servidor()) {
      const j = await this._api('primeiro-admin', 'POST', { login, nome, senha });
      this.token = j.token; this.usuario = j.usuario;
      Armaz.infoServidor.usuarios = true;
    } else {
      const u = await this._ler();
      if (Object.keys(u).length) throw new Error('O administrador já foi criado.');
      u[login] = { nome: nome.trim(), perfil: 'admin', ativo: true, criadoEm: new Date().toISOString(), ...await this._novaSenha(senha) };
      await this._gravar(u);
      this.usuario = { login, nome: nome.trim(), perfil: 'admin' };
    }
    this._guardar(true);
  },

  async entrar(login, senha, lembrar) {
    login = login.trim().toLowerCase();
    if (this.servidor()) {
      const j = await this._api('login', 'POST', { login, senha, lembrar });
      this.token = j.token; this.usuario = j.usuario;
    } else {
      const r = (await this._ler())[login];
      if (!r || !r.ativo || await this._hash(senha, r.sal, r.iter) !== r.hash) {
        await new Promise(ok => setTimeout(ok, 600));
        throw new Error('Usuário ou senha incorretos.');
      }
      this.usuario = { login, nome: r.nome, perfil: r.perfil };
    }
    this._guardar(lembrar);
  },

  // Retoma a sessão guardada neste aparelho (confere se o usuário continua ativo e com o mesmo perfil)
  async retomar() {
    const g = this._guardado();
    if (!g || g.modo !== Armaz.modo || !g.usuario) return false;
    try {
      if (this.servidor()) {
        this.token = g.token;
        this.usuario = (await this._api('eu')).usuario;
      } else {
        const r = (await this._ler())[g.usuario.login];
        if (!r || !r.ativo) { this.sair(); return false; }
        this.usuario = { login: g.usuario.login, nome: r.nome, perfil: r.perfil };
      }
      return true;
    } catch (e) {
      if (e.sessao) { this.sair(); return false; }
      throw e;
    }
  },

  async trocarSenha(atual, nova) {
    validarSenha(nova);
    if (this.servidor()) {
      const j = await this._api('senha', 'POST', { atual, nova });
      this.token = j.token;
      this._guardar(!!localStorage.getItem('cl-sessao'));
      return;
    }
    const u = await this._ler();
    const r = u[this.usuario.login];
    if (!r || await this._hash(atual, r.sal, r.iter) !== r.hash) throw new Error('A senha atual não confere.');
    Object.assign(r, await this._novaSenha(nova), { alteradoEm: new Date().toISOString() });
    await this._gravar(u);
  },

  async listar() {
    if (this.servidor()) return (await this._api('usuarios')).usuarios;
    return this._lista(await this._ler());
  },

  // dados = { login, nome, perfil, ativo, senha (opcional na edição) }
  async salvarUsuario(dados, novo) {
    if (!this.ehAdmin()) throw new Error('Somente o administrador pode alterar usuários.');
    const login = dados.login.trim().toLowerCase();
    if (this.servidor()) return (await this._api('usuarios', 'POST', { ...dados, login, novo })).usuarios;
    validarLogin(login);
    if (!dados.nome.trim()) throw new Error('Informe o nome.');
    if (novo || dados.senha) validarSenha(dados.senha);
    const u = await this._ler();
    if (novo && u[login]) throw new Error(`Já existe um usuário com o login "${login}".`);
    if (!novo && !u[login]) throw new Error('Usuário não encontrado.');
    const r = novo ? { criadoEm: new Date().toISOString() } : u[login];
    const perfil = dados.perfil === 'admin' ? 'admin' : 'usuario';
    if (!novo && r.perfil === 'admin' && r.ativo && (perfil !== 'admin' || !dados.ativo) && this._admins(u) <= 1) throw new Error('É preciso manter pelo menos um administrador ativo.');
    if (login === this.usuario.login && !dados.ativo) throw new Error('Você não pode desativar o próprio usuário.');
    Object.assign(r, { nome: dados.nome.trim(), perfil, ativo: !!dados.ativo, alteradoEm: new Date().toISOString() });
    if (dados.senha) Object.assign(r, await this._novaSenha(dados.senha));
    u[login] = r;
    await this._gravar(u);
    return this._lista(u);
  },

  async excluirUsuario(login) {
    if (!this.ehAdmin()) throw new Error('Somente o administrador pode excluir usuários.');
    if (this.servidor()) return (await this._api('usuarios?login=' + encodeURIComponent(login), 'DELETE')).usuarios;
    const u = await this._ler();
    if (login === this.usuario.login) throw new Error('Você não pode excluir o próprio usuário.');
    if (u[login]?.perfil === 'admin' && u[login].ativo && this._admins(u) <= 1) throw new Error('É preciso manter pelo menos um administrador ativo.');
    delete u[login];
    await this._gravar(u);
    return this._lista(u);
  },
};
