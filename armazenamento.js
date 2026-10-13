'use strict';
/*
  Armazenamento dos dados. Três formas, com a mesma organização de arquivos:
  - servidor: o aplicativo foi aberto pelo servidor.ps1, que grava na pasta configurada;
  - pasta:    Chrome/Edge no computador gravando direto numa pasta (rede ou sincronizada);
  - local:    somente neste navegador (para testes).
*/

const IDB = {
  _db: null,
  abrir() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, falha) => {
      const r = indexedDB.open('controle-locacoes', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('arquivos');
      };
      r.onsuccess = () => { this._db = r.result; ok(r.result); };
      r.onerror = () => falha(r.error);
    });
  },
  async get(loja, chave) {
    const db = await this.abrir();
    return new Promise((ok, falha) => {
      const r = db.transaction(loja).objectStore(loja).get(chave);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => falha(r.error);
    });
  },
  async set(loja, chave, valor) {
    const db = await this.abrir();
    return new Promise((ok, falha) => {
      const t = db.transaction(loja, 'readwrite');
      t.objectStore(loja).put(valor, chave);
      t.oncomplete = () => ok();
      t.onerror = () => falha(t.error);
    });
  },
};

// Falha de rede (servidor desligado, sem internet): mensagem clara em vez de "Failed to fetch"
class ErroConexao extends Error {
  constructor(onde) {
    super(onde === 'servidor'
      ? 'Não foi possível falar com o servidor. Verifique se a janela do servidor ("Iniciar servidor.bat") está aberta no computador principal e se este aparelho está na mesma rede; depois clique em "Tentar novamente".'
      : 'Não foi possível acessar a nuvem. Verifique a conexão com a internet e clique em "Tentar novamente".');
    this.conexao = true;
  }
}
async function buscar(url, opcoes, onde = 'servidor') {
  try { return await fetch(url, opcoes); }
  catch (e) { throw new ErroConexao(onde); }
}

const buscarNuvem = (url, opcoes) => buscar(url, opcoes, 'nuvem');

// Outra pessoa gravou o mesmo arquivo entre a leitura e a gravação (trava do Dropbox): o app relê e refaz
class ErroCorrida extends Error {
  constructor(caminho) { super(`O arquivo ${caminho} foi alterado em outro aparelho no mesmo instante. Tente novamente.`); this.corrida = true; }
}

// Repete uma operação de ler-juntar-gravar quando a trava recusa a gravação por concorrência
async function comTrava(operacao, tentativas = 5) {
  for (let i = 1; ; i++) {
    try { return await operacao(); }
    catch (e) {
      if (!e.corrida || i >= tentativas) throw e;
      await new Promise(ok => setTimeout(ok, 150 + Math.random() * 450 * i));
    }
  }
}

const Armaz = {
  modo: null,
  dir: null,
  infoServidor: null,

  async detectarServidor() {
    if (!location.protocol.startsWith('http')) return false;
    try {
      const r = await fetch('api/ping', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j.ok || j.app !== 'controle-locacoes') return false;
      this.modo = 'servidor';
      this.infoServidor = j;
      return true;
    } catch { return false; }
  },

  cabecalhos() {
    return Auth.token ? { Authorization: 'Bearer ' + Auth.token } : {};
  },

  async conectarPasta() {
    const h = await window.showDirectoryPicker({ id: 'controle-locacoes', mode: 'readwrite' });
    await IDB.set('kv', 'pasta', h);
    this.dir = h;
    this.modo = 'pasta';
    localStorage.setItem('cl-modo', 'pasta');
  },

  async retomarPasta(pedirPermissao) {
    if (!('showDirectoryPicker' in window)) return false;
    const h = await IDB.get('kv', 'pasta').catch(() => null);
    if (!h) return false;
    let p = await h.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && pedirPermissao) p = await h.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') return false;
    this.dir = h;
    this.modo = 'pasta';
    return true;
  },

  usarLocal() {
    this.modo = 'local';
    localStorage.setItem('cl-modo', 'local');
  },

  desconectar() {
    localStorage.removeItem('cl-modo');
  },

  descricao() {
    if (this.modo === 'servidor') return 'Servidor · ' + location.host;
    if (this.modo === 'pasta') return 'Pasta · ' + (this.dir?.name || '');
    if (this.modo === 'local') return 'Somente neste navegador';
    if (this.modo === 'dropbox') return 'Dropbox · ' + NuvemDropbox.pasta;
    if (this.modo === 'gdrive') return 'Google Drive · ' + (localStorage.getItem('cl-gdr-nome') || 'pasta compartilhada');
    return '';
  },

  usarNuvem(modo) {
    this.modo = modo;
    localStorage.setItem('cl-modo', modo);
  },

  async _arquivo(caminho, criar) {
    const partes = caminho.split('/');
    let d = this.dir;
    for (let i = 0; i < partes.length - 1; i++) d = await d.getDirectoryHandle(partes[i], { create: criar });
    return d.getFileHandle(partes[partes.length - 1], { create: criar });
  },

  // Devolve o texto do arquivo ou null se ele não existir
  async ler(caminho) {
    if (this.modo === 'servidor') {
      const r = await buscar('api/arquivo?caminho=' + encodeURIComponent(caminho), { cache: 'no-store', headers: this.cabecalhos() });
      if (r.status === 404) return null;
      if (r.status === 401) throw new ErroSessao();
      if (r.status === 403) throw new Error(`Acesso restrito ao administrador (${caminho}).`);
      if (!r.ok) throw new Error(`Erro ${r.status} ao ler ${caminho} no servidor.`);
      return await r.text();
    }
    if (this.modo === 'pasta') {
      try {
        const fh = await this._arquivo(caminho, false);
        return await (await fh.getFile()).text();
      } catch (e) {
        if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
        throw e;
      }
    }
    if (this.modo === 'local') {
      const v = await IDB.get('arquivos', caminho);
      return v === undefined ? null : v;
    }
    if (this.modo === 'dropbox') return NuvemDropbox.ler(caminho);
    if (this.modo === 'gdrive') return NuvemGoogle.ler(caminho);
    throw new Error('O local de armazenamento não foi escolhido.');
  },

  async gravar(caminho, texto) {
    if (this.modo === 'servidor') {
      const r = await buscar('api/arquivo?caminho=' + encodeURIComponent(caminho), {
        method: 'PUT', body: texto,
        headers: { 'Content-Type': 'application/json', ...this.cabecalhos() },
      });
      if (r.status === 401) throw new ErroSessao();
      if (r.status === 403) throw new Error((await r.json().catch(() => ({}))).erro || 'Somente o administrador pode fazer esta alteração.');
      if (!r.ok) throw new Error(`Erro ${r.status} ao gravar ${caminho} no servidor: ${await r.text()}`);
      return;
    }
    if (this.modo === 'pasta') {
      const fh = await this._arquivo(caminho, true);
      const w = await fh.createWritable();
      await w.write(texto);
      await w.close();
      return;
    }
    if (this.modo === 'local') return IDB.set('arquivos', caminho, texto);
    if (this.modo === 'dropbox') return NuvemDropbox.gravar(caminho, texto);
    if (this.modo === 'gdrive') return NuvemGoogle.gravar(caminho, texto);
    throw new Error('O local de armazenamento não foi escolhido.');
  },
};
