'use strict';
/* Login, primeiro administrador, minha conta, usuários e servidor (área do administrador) */

/* ================= Login ================= */
async function telaLogin(mensagem) {
  document.body.classList.remove('conectado', 'admin', 'menu-aberto');
  $('#usuarioTopo').innerHTML = '';
  $('#statusArmaz').textContent = Armaz.descricao();
  const c = $('#conteudo');
  let tem;
  try { tem = await Auth.temUsuarios(); }
  catch (e) {
    c.innerHTML = `<section class="cartao erro caixa-login"><h2>Sem conexão com os dados</h2><p>${esc(e.message)}</p><button class="bt primario" onclick="location.reload()">Tentar novamente</button></section>`;
    return;
  }
  let outroLocal = Armaz.modo !== 'servidor' && !dropboxFixo() ? '<p class="dica"><a href="#" id="lnkOutroLocal">Usar outro local de dados neste aparelho</a></p>' : '';
  // Dropbox fixo: mostra a conta conectada e permite desconectar (ex.: aparelho ligado à conta pessoal por engano)
  if (dropboxFixo() && Armaz.modo === 'dropbox') {
    const conta = await NuvemDropbox.conta().catch(() => null);
    const qual = conta ? `<b>${esc(conta.nome)}</b>${conta.email ? ' (' + esc(conta.email) + ')' : ''}${conta.equipe ? ' · equipe ' + esc(conta.equipe) : ''}` : 'conta não identificada';
    outroLocal = `<p class="dica conta-dbx">Dados no Dropbox de ${qual}. Não é a conta da administradora? <a href="#" id="lnkDesconectarDbx">Desconectar este aparelho do Dropbox</a></p>`;
  }

  if (!tem && !Auth.podeCriarPrimeiroAdmin()) {
    c.innerHTML = `<section class="cartao caixa-login"><h1>Controle de Locações</h1>
      <p>Primeiro acesso: o administrador ainda não foi criado.</p>
      <p>Ele deve ser criado no <b>computador do servidor</b>, abrindo no navegador de lá o endereço <b>http://localhost:${esc(location.port || '80')}</b>.</p>
      <button class="bt" onclick="location.reload()">Tentar novamente</button></section>`;
    return;
  }

  if (!tem) {
    c.innerHTML = `<section class="cartao caixa-login form"><h1>Primeiro acesso</h1>
      ${dropboxFixo() ? '<p class="alerta">Não há dados nem usuários nesta conta do Dropbox. Se a administradora já usa o aplicativo, este aparelho foi conectado à conta errada: use <b>Desconectar este aparelho do Dropbox</b>, no fim desta tela, e não crie o administrador aqui.</p>' : ''}
      <p>Crie o <b>administrador</b>: ele cadastra os demais usuários e é o único com acesso à área de administração (dados da administradora, usuários, armazenamento e servidor).</p>
      <form id="formLogin" class="grade-login">
        <div class="campo"><label for="lgNome">Seu nome</label><input id="lgNome" required autocomplete="name"></div>
        <div class="campo"><label for="lgLogin">Login</label><input id="lgLogin" required autocapitalize="off" autocomplete="username" placeholder="ex.: maria"></div>
        <div class="campo"><label for="lgSenha">Senha (mínimo 6 caracteres)</label><input id="lgSenha" type="password" required autocomplete="new-password"></div>
        <div class="campo"><label for="lgSenha2">Repita a senha</label><input id="lgSenha2" type="password" required autocomplete="new-password"></div>
        <button class="bt primario" type="submit">Criar administrador e entrar</button>
      </form>${outroLocal}</section>`;
    $('#formLogin').addEventListener('submit', e => {
      e.preventDefault();
      executar(async () => {
        if ($('#lgSenha').value !== $('#lgSenha2').value) throw new Error('As senhas não conferem.');
        await Auth.criarPrimeiroAdmin({ nome: $('#lgNome').value, login: $('#lgLogin').value, senha: $('#lgSenha').value });
        aviso('Administrador criado.');
        location.hash = '#/admin';
        await conectado();
      });
    });
  } else {
    c.innerHTML = `<section class="cartao caixa-login form"><h1>Controle de Locações</h1>
      ${mensagem ? `<p class="alerta">${esc(mensagem)}</p>` : ''}
      <form id="formLogin" class="grade-login">
        <div class="campo"><label for="lgLogin">Login</label><input id="lgLogin" required autocapitalize="off" autocomplete="username" value="${esc(localStorage.getItem('cl-ultimo-login') || '')}"></div>
        <div class="campo"><label for="lgSenha">Senha</label><input id="lgSenha" type="password" required autocomplete="current-password"></div>
        <label class="inline"><input type="checkbox" id="lgLembrar"> Manter conectado neste aparelho</label>
        <button class="bt primario" type="submit">Entrar</button>
      </form>
      <p class="dica">Esqueceu a senha? Peça ao administrador para definir uma nova.</p>${outroLocal}${dropboxFixo() ? dicaInstalarHTML() : ''}</section>`;
    ligarInstalar();
    ($('#lgLogin').value ? $('#lgSenha') : $('#lgLogin')).focus();
    $('#formLogin').addEventListener('submit', e => {
      e.preventDefault();
      executar(async () => {
        const b = $('#formLogin button[type=submit]');
        b.disabled = true;
        try { await Auth.entrar($('#lgLogin').value, $('#lgSenha').value, $('#lgLembrar').checked); }
        finally { b.disabled = false; }
        localStorage.setItem('cl-ultimo-login', Auth.usuario.login);
        await conectado();
      });
    });
  }
  $('#lnkOutroLocal')?.addEventListener('click', e => { e.preventDefault(); Armaz.desconectar(); Armaz.modo = null; Auth.sair(); telaConexao(); });
  $('#lnkDesconectarDbx')?.addEventListener('click', e => {
    e.preventDefault();
    if (!confirm('Desconectar este aparelho do Dropbox? Nada é apagado no Dropbox. Depois, ative o aparelho com o convite enviado pelo administrador ou conecte com a conta do Dropbox da administradora.')) return;
    NuvemDropbox.sair(); Armaz.desconectar(); Auth.sair();
    location.hash = ''; location.reload();
  });
}

/* ================= Minha conta ================= */
function telaConta() {
  const u = Auth.usuario;
  $('#conteudo').innerHTML = cabecalho('Minha conta') + `
  <section class="cartao">
    <dl class="dados">
      <div><dt>Nome</dt><dd>${esc(u.nome)}</dd></div>
      <div><dt>Login</dt><dd>${esc(u.login)}</dd></div>
      <div><dt>Perfil</dt><dd>${u.perfil === 'admin' ? 'Administrador' : 'Usuário'}</dd></div>
      <div><dt>Dados em</dt><dd>${esc(Armaz.descricao())}</dd></div>
    </dl>
  </section>
  <section class="cartao form">
    <h2>Trocar minha senha</h2>
    <form id="formSenha" class="grade-form">
      <div class="campo"><label for="snAtual">Senha atual</label><input id="snAtual" type="password" required autocomplete="current-password"></div>
      <div class="campo"><label for="snNova">Nova senha</label><input id="snNova" type="password" required autocomplete="new-password"></div>
      <div class="campo"><label for="snNova2">Repita a nova senha</label><input id="snNova2" type="password" required autocomplete="new-password"></div>
      <div class="campo"><label>&nbsp;</label><button class="bt primario" type="submit">Trocar senha</button></div>
    </form>
  </section>
  ${Auth.ehAdmin() ? '<p><a class="bt" href="#/admin">Ir para a Administração</a></p>' : ''}`;
  $('#formSenha').addEventListener('submit', e => {
    e.preventDefault();
    executar(async () => {
      if ($('#snNova').value !== $('#snNova2').value) throw new Error('As senhas novas não conferem.');
      await Auth.trocarSenha($('#snAtual').value, $('#snNova').value);
      e.target.reset();
      aviso('Senha alterada.');
    });
  });
}

/* ================= Usuários (administrador) ================= */
function secaoUsuariosHTML() {
  return `<section class="cartao" id="secUsuarios">
    <div class="cartao-cab"><h2>Usuários</h2><button class="bt primario pequeno" id="btNovoUsu">+ Novo usuário</button></div>
    <p class="dica"><b>Administrador</b>: acesso a tudo, inclusive a esta área. <b>Usuário</b>: cadastros, contratos, meses, cobrança e relatórios, sem acesso à Administração (dados da administradora, usuários, rubricas e encargos padrão, armazenamento e servidor). Passe a cada pessoa o login e a senha inicial; ela pode trocar a senha em <b>Minha conta</b>.</p>
    <div id="listaUsu"><p class="carregando">Carregando…</p></div>
  </section>`;
}

function ligarUsuarios() {
  const render = lista => {
    $('#listaUsu').innerHTML = `<div class="rolagem"><table class="tabela"><thead><tr><th>Nome</th><th>Login</th><th>Perfil</th><th>Situação</th><th></th></tr></thead><tbody>
      ${lista.map(u => `<tr><td>${esc(u.nome)}${u.login === Auth.usuario.login ? ' <span class="dica">(você)</span>' : ''}</td><td>${esc(u.login)}</td>
        <td>${u.perfil === 'admin' ? '<span class="chip reajuste">Administrador</span>' : 'Usuário'}</td>
        <td>${u.ativo ? '<span class="chip fechado">Ativo</span>' : '<span class="chip neutro">Desativado</span>'}</td>
        <td class="acoes-tab"><button class="bt pequeno" data-editar="${esc(u.login)}">Editar</button>${u.login === Auth.usuario.login ? '' : `<button class="bt pequeno perigo" data-excluir="${esc(u.login)}">Excluir</button>`}</td></tr>`).join('')}
    </tbody></table></div>`;
    $$('[data-editar]').forEach(b => b.addEventListener('click', () => formUsuario(lista.find(u => u.login === b.dataset.editar))));
    $$('[data-excluir]').forEach(b => b.addEventListener('click', () => executar(async () => {
      if (!confirm(`Excluir o usuário "${b.dataset.excluir}"? Ele perderá o acesso imediatamente. (Para suspender o acesso sem excluir, use Editar > desativado.)`)) return;
      render(await Auth.excluirUsuario(b.dataset.excluir));
      aviso('Usuário excluído.');
    })));
  };

  const formUsuario = u => {
    const novo = !u;
    u = u || { login: '', nome: '', perfil: 'usuario', ativo: true };
    abrirModal(`<div class="modal-cab"><h2>${novo ? 'Novo usuário' : 'Editar usuário'}</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
      <form id="formUsu" class="grade-form form-modal">
        <div class="campo w2"><label for="fuNome">Nome</label><input id="fuNome" required value="${esc(u.nome)}"></div>
        <div class="campo"><label for="fuLogin">Login</label><input id="fuLogin" required autocapitalize="off" value="${esc(u.login)}"${novo ? '' : ' readonly'}></div>
        <div class="campo"><label for="fuPerfil">Perfil</label><select id="fuPerfil"><option value="usuario"${u.perfil !== 'admin' ? ' selected' : ''}>Usuário</option><option value="admin"${u.perfil === 'admin' ? ' selected' : ''}>Administrador</option></select></div>
        <div class="campo"><label for="fuSenha">${novo ? 'Senha inicial' : 'Nova senha'}</label><input id="fuSenha" type="password" autocomplete="new-password"${novo ? ' required' : ''} placeholder="${novo ? 'mínimo 6 caracteres' : 'em branco: mantém a atual'}"></div>
        <div class="campo"><label for="fuSenha2">Repita a senha</label><input id="fuSenha2" type="password" autocomplete="new-password"></div>
        <div class="campo w2"><label class="inline"><input type="checkbox" id="fuAtivo"${u.ativo ? ' checked' : ''}> Acesso ativo</label></div>
        <div class="campo wfull acoes-linha"><span class="espaco"></span><button type="button" class="bt" data-fechar>Cancelar</button><button class="bt primario" type="submit">Salvar</button></div>
      </form>`);
    $('#formUsu').addEventListener('submit', e => {
      e.preventDefault();
      executar(async () => {
        const senha = $('#fuSenha').value;
        if (senha !== $('#fuSenha2').value) throw new Error('As senhas não conferem.');
        const dados = { login: $('#fuLogin').value, nome: $('#fuNome').value, perfil: $('#fuPerfil').value, ativo: $('#fuAtivo').checked, senha };
        const lista = await Auth.salvarUsuario(dados, novo);
        fecharModal();
        // Alterou o próprio perfil ou a própria senha: entra de novo com os dados atualizados
        if (dados.login.trim().toLowerCase() === Auth.usuario.login && (senha || dados.perfil !== Auth.usuario.perfil)) {
          aviso('Seus dados de acesso mudaram. Entre novamente.');
          Auth.sair();
          return telaLogin();
        }
        render(lista);
        aviso(novo ? `Usuário criado. Passe o login "${dados.login.trim().toLowerCase()}" e a senha inicial para a pessoa.` : 'Usuário atualizado.');
      });
    });
    $('#fuNome').focus();
  };

  $('#btNovoUsu').addEventListener('click', () => formUsuario(null));
  executar(async () => render(await Auth.listar()));
}

/* ================= Servidor (administrador, modo servidor) ================= */
function secaoServidorHTML() {
  return `<section class="cartao form" id="secServidor"><h2>Servidor</h2><div id="infoServ"><p class="carregando">Consultando o servidor…</p></div></section>`;
}

// Espera o servidor voltar depois de reiniciar e recarrega o aplicativo (no novo endereço, se a porta mudou)
async function aguardarReinicio(porta) {
  abrirModal('<div class="modal-cab"><h2>Reiniciando o servidor…</h2></div><p>Aguarde alguns segundos. O aplicativo será recarregado automaticamente.</p><p class="carregando" id="msgReinicio"></p>');
  const mesmaPorta = String(porta) === (location.port || (location.protocol === 'https:' ? '443' : '80'));
  const base = mesmaPorta ? '' : `${location.protocol}//${location.hostname}:${porta}/`;
  await new Promise(ok => setTimeout(ok, 1500));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + 'api/ping', { cache: 'no-store', ...(mesmaPorta ? {} : { mode: 'no-cors' }) });
      if (!mesmaPorta || r.ok) { if (mesmaPorta) location.reload(); else location.href = base; return; }
    } catch { /* ainda reiniciando */ }
    $('#msgReinicio').textContent = 'Tentando conectar… (' + (i + 1) + ')';
    await new Promise(ok => setTimeout(ok, 1500));
  }
  $('#msgReinicio').textContent = 'O servidor não respondeu. Verifique a janela do servidor no computador principal (se ela foi fechada, abra de novo o "Iniciar servidor.bat").';
}

function ligarServidor() {
  const carregar = () => executar(async () => {
    const s = await Auth._api('servidor');
    $('#infoServ').innerHTML = `
      <p>Computador do servidor: <b>${esc(s.computador)}</b>. Endereço neste computador: <b>http://localhost:${s.porta}</b>.</p>
      ${s.acessoRede ? `<p>Endereços para os outros computadores e celulares da rede:<br>${s.enderecos.map(e => `<b>${esc(e)}</b>`).join('<br>')}</p>`
        : '<p class="alerta">O acesso pelos outros computadores e pelo celular ainda não está liberado (veja “Acesso pela rede”, abaixo).</p>'}
      <h3 class="sec">Pasta dos dados e porta</h3>
      <div class="grade-form">
        <div class="campo w2"><label for="svPasta">Pasta onde os dados são gravados (no computador do servidor)</label><input id="svPasta" value="${esc(s.pasta)}"><small>Pode ser uma pasta da rede, por exemplo \\\\SERVIDOR\\Locacoes\\dados</small></div>
        <div class="campo"><label for="svPorta">Porta</label><input id="svPorta" type="number" min="1024" max="65535" value="${s.porta}"></div>
        <div class="campo wfull" id="svCopiarCampo" hidden><label class="inline"><input type="checkbox" id="svCopiar" checked> Copiar os dados atuais para a nova pasta</label>
          <small>Desmarque para passar a usar os dados que já existem na nova pasta. Os usuários são levados de qualquer forma.</small></div>
      </div>
      <div class="acoes-linha"><button class="bt primario" id="btSvSalvar">Salvar e reiniciar o servidor</button><button class="bt" id="btSvReiniciar">Reiniciar o servidor</button></div>
      <h3 class="sec">Início automático</h3>
      <p>${s.inicioAutomatico ? 'O servidor <b>inicia automaticamente</b> quando o Windows é ligado (janela minimizada).' : 'O servidor <b>não</b> inicia sozinho: é preciso abrir o “Iniciar servidor.bat” depois de ligar o computador.'}</p>
      <div class="acoes-linha"><button class="bt" id="btSvAuto">${s.inicioAutomatico ? 'Desativar o início automático' : 'Iniciar automaticamente com o Windows'}</button></div>
      <h3 class="sec">Acesso pela rede</h3>
      <p>${s.acessoRede ? 'Liberado: outros computadores e celulares da rede podem acessar.' : 'Ainda não liberado.'}</p>
      <div class="acoes-linha"><button class="bt" id="btSvRede"${s.local ? '' : ' disabled'}>${s.acessoRede ? 'Liberar novamente' : 'Liberar acesso na rede'}</button></div>
      <p class="dica">${s.local ? 'O Windows vai pedir autorização (janela “Deseja permitir…”) neste computador. Depois, o servidor reinicia sozinho.' : 'Por segurança, a liberação só pode ser feita no próprio computador do servidor, abrindo lá http://localhost:' + s.porta + '.'}</p>
      <h3 class="sec" id="secAtualizacao">Versão e atualização</h3>
      <p>Versão instalada: <b>${esc(s.versaoApp || '1.0.0')}</b> <span class="dica">(${esc(s.instalacao || '')})</span></p>
      <div class="campo-arquivo"><input type="file" id="svPacote" accept=".zip,application/zip"><button class="bt primario" id="btSvAtualizar" disabled>Instalar atualização</button></div>
      <p class="dica">Escolha o arquivo .zip da versão nova. Antes de atualizar, o app guarda uma cópia da versão atual e dos dados em <b>_versoes_anteriores</b>, dentro da pasta da instalação. Só os arquivos do programa são trocados: <b>dados, usuários e configurações não são alterados</b>. Depois, o servidor reinicia sozinho.</p>`;
    $('#svPacote').addEventListener('change', e => { $('#btSvAtualizar').disabled = !e.target.files[0]; });
    $('#btSvAtualizar').addEventListener('click', () => executar(async () => {
      const arq = $('#svPacote').files[0];
      if (!arq) return;
      if (!/\.zip$/i.test(arq.name)) throw new Error('Escolha o arquivo .zip da versão nova.');
      if (!confirm(`Instalar a atualização "${arq.name}"?\n\nO app guarda antes uma cópia da versão atual e dos dados. Dados, usuários e configurações não são alterados.\n\nO servidor será reiniciado: quem estiver usando o app verá a conexão cair por alguns segundos.`)) return;
      const b = $('#btSvAtualizar');
      b.disabled = true; b.textContent = 'Instalando…';
      try {
        const r = await buscar('api/servidor/atualizar', { method: 'POST', headers: { Authorization: 'Bearer ' + Auth.token, 'Content-Type': 'application/zip' }, body: arq });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) throw new ErroSessao();
        if (!r.ok) throw new Error(j.erro || `Erro ${r.status} ao instalar a atualização.`);
        sessionStorage.setItem('cl-atualizado', `Atualização instalada: versão ${j.versaoAnterior} → ${j.versaoNova}. Dados, usuários e configurações foram mantidos.`);
        await aguardarReinicio(j.porta);
      } finally { b.disabled = false; b.textContent = 'Instalar atualização'; }
    }));
    const pastaOriginal = s.pasta;
    $('#svPasta').addEventListener('input', e => { $('#svCopiarCampo').hidden = e.target.value.trim() === pastaOriginal; });
    $('#btSvSalvar').addEventListener('click', () => executar(async () => {
      const pasta = $('#svPasta').value.trim(), porta = +$('#svPorta').value;
      if (pasta === pastaOriginal && porta === s.porta) return aviso('Nada foi alterado.');
      const msg = [pasta !== pastaOriginal ? `Os dados passarão a ser gravados em:\n${pasta}\n(${$('#svCopiar').checked ? 'os dados atuais serão copiados para lá' : 'serão usados os dados que já estão nessa pasta'})` : '',
        porta !== s.porta ? `O endereço passará a usar a porta ${porta}. Os outros aparelhos precisarão usar o novo endereço${s.acessoRede ? ' e será preciso liberar o acesso na rede de novo' : ''}.` : ''].filter(Boolean).join('\n\n');
      if (!confirm(msg + '\n\nO servidor será reiniciado. Continuar?')) return;
      const r = await Auth._api('servidor', 'POST', { pasta, porta, copiar: $('#svCopiar').checked });
      await aguardarReinicio(r.porta);
    }));
    $('#btSvReiniciar').addEventListener('click', () => executar(async () => {
      if (!confirm('Reiniciar o servidor agora? Quem estiver usando o aplicativo verá a conexão cair por alguns segundos.')) return;
      const r = await Auth._api('servidor/reiniciar', 'POST', {});
      await aguardarReinicio(r.porta);
    }));
    $('#btSvAuto').addEventListener('click', () => executar(async () => {
      const r = await Auth._api('servidor/inicio-automatico', 'POST', { ativar: !s.inicioAutomatico });
      aviso(r.inicioAutomatico ? 'O servidor passará a iniciar com o Windows.' : 'Início automático desativado.');
      carregar();
    }));
    $('#btSvRede').addEventListener('click', () => executar(async () => {
      if (!confirm('Liberar o acesso pela rede? O Windows vai pedir sua autorização neste computador.')) return;
      const b = $('#btSvRede'); b.disabled = true; b.textContent = 'Aguardando a autorização do Windows…';
      try {
        const r = await Auth._api('servidor/liberar-rede', 'POST', {});
        await aguardarReinicio(r.porta);
      } finally { b.disabled = false; b.textContent = 'Liberar acesso na rede'; }
    }));
  });
  carregar();
}
