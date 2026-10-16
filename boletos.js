'use strict';
/* Prévia de boletos: dados de cada contrato no mês, prontos para copiar e colar no banco */

const LARGURA_PADRAO = 80;
const larguraBoleto = () => {
  try { return Math.min(200, Math.max(30, +localStorage.getItem('cl-bol-largura') || LARGURA_PADRAO)); } catch { return LARGURA_PADRAO; }
};

// Copia texto. Fora de endereço seguro (http na rede) a API moderna não existe: usa o método antigo.
async function copiarTexto(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; }
  } catch { /* tenta o método antigo */ }
  const ta = document.createElement('textarea');
  ta.value = texto;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

// Agrupa os itens em no máximo "maxLinhas" linhas de até "largura" caracteres.
// Se não couber, os últimos itens são somados em "Outros encargos".
function empacotarLinhas(itens, largura, maxLinhas = 3) {
  const montar = lista => {
    const linhas = [];
    let atual = '';
    for (const t of lista) {
      const junto = atual ? atual + '; ' + t : t;
      if (junto.length <= largura) atual = junto;
      else { if (atual) linhas.push(atual); atual = t.length > largura ? t.slice(0, largura) : t; }
    }
    if (atual) linhas.push(atual);
    return linhas;
  };
  let lista = itens.map(i => ({ ...i }));
  const texto = l => l.map(i => `${i.rotulo} ${i.valor < 0 ? '-' : ''}R$ ${fmtNum(Math.abs(i.valor))}`);
  while (montar(texto(lista)).length > maxLinhas && lista.length > 2) {
    const b = lista.pop(), a = lista.pop();
    lista.push({ rotulo: 'Outros encargos', valor: r2(a.valor + b.valor), fixo: false });
  }
  return montar(texto(lista)).slice(0, maxLinhas);
}

// Dados do boleto de um contrato num mês
function dadosBoleto(ct, ym, mes, k) {
  const lt = D.locatarios[ct.locatarioId] || {}, lo = D.locadores[ct.locadorId] || {}, im = D.imoveis[ct.imovelId] || {};
  const valor = k.situacao === 'parcial' ? k.emAberto : k.devido;
  const itens = [
    ...(mes.linhas || []).filter(l => cent(l.cobrado)).map(l => ({ rotulo: l.rubrica, valor: r2(l.cobrado) })),
    ...(mes.ajustes || []).filter(a => cent(a.valor)).map(a => ({ rotulo: a.tipo === 'reembolso' ? 'Reembolso' : 'Desconto', valor: -r2(a.valor) })),
  ];
  // A referência abre a primeira linha
  if (itens.length) itens[0] = { ...itens[0], rotulo: `Ref. ${mesNum(ym)}: ${itens[0].rotulo}` };
  if (k.situacao === 'parcial') itens.push({ rotulo: 'Já pago', valor: -r2(k.diferido ? k.diferido.principal : k.principalRecebido) });
  const p = paramsMora(ct);
  const endereco = [descImovel(im), im.cep ? 'CEP ' + im.cep : ''].filter(Boolean).join(' - ');
  return {
    ct, ym, situacao: k.situacao,
    pagadorNome: lt.nome || '', pagadorDoc: lt.documento || '', pagadorEndereco: endereco,
    locadorNome: lo.nome || '', locadorDoc: lo.documento || '',
    vencimento: fmtData(vencimentoMes(ct, ym, mes)), valor: fmtNum(valor), valorNum: valor,
    linhas: empacotarLinhas(itens, larguraBoleto()),
    instrucoes: `Após o vencimento, cobrar multa de ${fmtPct(p.multa)}% e juros de mora de ${fmtPct(p.juros)}% ao mês (pro rata die).`,
    referencia: `${rotuloContrato(ct)} - ${imovelCurto(im)}`,
  };
}

const textoCompletoBoleto = b => [
  `Pagador (locatário): ${b.pagadorNome}`, `CPF/CNPJ do pagador: ${b.pagadorDoc}`, `Endereço do pagador: ${b.pagadorEndereco}`,
  `Locador: ${b.locadorNome}`, `CPF/CNPJ do locador: ${b.locadorDoc}`,
  `Vencimento: ${b.vencimento}`, `Valor: R$ ${b.valor}`, ...b.linhas.map((l, i) => `Linha ${i + 1}: ${l}`), `Instruções: ${b.instrucoes}`,
].join('\n');

// Cartão com cada campo e o botão de copiar ao lado
function cartaoBoletoHTML(b, i) {
  const campo = (rotulo, valor, cls = '') => `<div class="bol-campo ${cls}"><span class="bol-rot">${rotulo}</span><span class="bol-val">${esc(valor) || '<span class="neg">não informado</span>'}</span>${valor ? `<button class="bt-copiar" data-copiar="${esc(valor)}" title="Copiar">Copiar</button>` : '<span></span>'}</div>`;
  const chip = b.situacao === 'pago' ? '<span class="chip fechado">Pago</span>' : b.situacao === 'parcial' ? '<span class="chip aberto">Saldo de pagamento parcial</span>' : '';
  return `<section class="cartao bol-cartao" data-bol="${i}">
    <div class="cartao-cab"><div><h2>${esc(b.referencia)}</h2><div class="dica">${esc(mesNum(b.ym))} ${chip}</div></div>
      <div class="acoes"><button class="bt pequeno" data-copiar-tudo="${i}">Copiar tudo</button></div></div>
    <div class="bol-grade">
      ${campo('Pagador (locatário)', b.pagadorNome)}${campo('CPF/CNPJ do pagador', b.pagadorDoc)}
      ${campo('Endereço do pagador', b.pagadorEndereco, 'larga')}
      ${campo('Locador', b.locadorNome)}${campo('CPF/CNPJ do locador', b.locadorDoc)}
      ${campo('Vencimento', b.vencimento)}${campo('Valor (R$)', b.valor)}
      ${b.linhas.map((l, j) => campo(`Texto – linha ${j + 1}`, l, 'larga mono')).join('')}
      ${campo('Instruções após o vencimento', b.instrucoes, 'larga')}
    </div>
  </section>`;
}

function ligarCopiar(raiz, boletos) {
  raiz.addEventListener('click', async e => {
    const b = e.target.closest('[data-copiar], [data-copiar-tudo]');
    if (!b) return;
    const texto = b.dataset.copiarTudo !== undefined ? textoCompletoBoleto(boletos[+b.dataset.copiarTudo]) : b.dataset.copiar;
    if (await copiarTexto(texto)) {
      const antes = b.textContent;
      b.textContent = 'Copiado';
      b.classList.add('copiado');
      setTimeout(() => { b.textContent = antes; b.classList.remove('copiado'); }, 1400);
    } else aviso('Não foi possível copiar automaticamente. Selecione o texto e use Ctrl+C.', 'erro');
  });
}

/* ================= Tela: prévia de boletos do mês ================= */
async function telaBoletos(h) {
  const q = new URLSearchParams(h.split('?')[1] || '');
  const ym = ehMes(q.get('mes')) ? q.get('mes') : mesAtual();
  const todos = q.get('todos') === '1';
  const ativos = contratosAtivos();
  const exts = await Promise.all(ativos.map(c => carregarExtrato(c.id)));
  const boletos = [], semMes = [];
  ativos.forEach((ct, i) => {
    const cad = calcularExtrato(ct, exts[i]);
    const x = cad.find(z => z.ym === ym);
    if (!x) { if (ym >= inicioControle(ct)) semMes.push(ct); return; }
    if (!todos && (x.c.situacao === 'pago' || x.c.devido <= 0)) return;
    boletos.push(dadosBoleto(ct, ym, x.mes, x.c));
  });
  const total = boletos.reduce((s, b) => s + cent(b.valorNum), 0) / 100;

  $('#conteudo').innerHTML = cabecalho(`Boletos de ${nomeMes(ym)} (prévia)`, 'Dados para emitir os boletos no banco: copie e cole cada campo',
    `<a class="bt" href="#/boletos?mes=${addMes(ym, -1)}${todos ? '&todos=1' : ''}" title="Mês anterior">&#9664;</a>
     <input type="month" id="mesBol" value="${ym}">
     <a class="bt" href="#/boletos?mes=${addMes(ym, 1)}${todos ? '&todos=1' : ''}" title="Próximo mês">&#9654;</a>`) + `
  <section class="cartao">
    <div class="barra-bol">
      <label class="inline"><input type="checkbox" id="bolTodos"${todos ? ' checked' : ''}> Incluir meses já pagos</label>
      <label class="inline">Caracteres por linha do texto <input type="number" id="bolLargura" min="30" max="200" value="${larguraBoleto()}" class="num"></label>
      <span class="espaco"></span>
      ${boletos.length ? botoesPDF('bolPdf') + '<button class="bt" id="btBolXlsx">Salvar planilha Excel</button>' : ''}
    </div>
    <p class="dica">${boletos.length} boleto${boletos.length === 1 ? '' : 's'} · total de <b>${fmtMoeda(total)}</b>. Ajuste os caracteres por linha ao limite do campo de texto do seu banco (o texto é refeito na hora).
    ${semMes.length ? `<br><span class="neg">${semMes.length} contrato${semMes.length > 1 ? 's' : ''} sem o mês gerado: ${semMes.map(c => esc(c.codigo)).join(', ')}.</span> <a href="#/painel/${ym}">Gerar no painel</a>` : ''}</p>
  </section>
  <div id="listaBol">${boletos.length ? boletos.map(cartaoBoletoHTML).join('') : '<section class="cartao"><p class="vazio">Nenhum boleto a emitir neste mês.</p></section>'}</div>`;

  ligarCopiar($('#listaBol'), boletos);
  const ir = mud => {
    const n = { mes: ym, todos, ...mud };
    location.hash = '#/boletos?' + new URLSearchParams({ mes: n.mes, ...(n.todos ? { todos: '1' } : {}) });
  };
  $('#mesBol').addEventListener('change', e => { if (ehMes(e.target.value)) ir({ mes: e.target.value }); });
  $('#bolTodos').addEventListener('change', e => ir({ todos: e.target.checked }));
  $('#bolLargura').addEventListener('change', e => {
    try { localStorage.setItem('cl-bol-largura', String(Math.min(200, Math.max(30, +e.target.value || LARGURA_PADRAO)))); } catch { /* sem armazenamento */ }
    telaBoletos(h);
  });

  const cols = [{ t: 'Contrato', w: 12, xw: 10 }, { t: 'Pagador (locatário)', w: 30, xw: 30 }, { t: 'CPF/CNPJ do pagador', w: 22, xw: 20 }, { t: 'Endereço do pagador', w: 44, xw: 50 },
    { t: 'Locador', w: 28, xw: 30 }, { t: 'CPF/CNPJ do locador', w: 22, xw: 20 }, { t: 'Vencimento', w: 18, xw: 12 }, { t: 'Valor', w: 18, tipo: 'moeda', xw: 13 },
    { t: 'Texto – linha 1', w: 50, xw: 60 }, { t: 'Texto – linha 2', w: 50, xw: 60 }, { t: 'Texto – linha 3', w: 50, xw: 60 }, { t: 'Instruções', w: 40, xw: 60 }];
  const linhas = () => boletos.map(b => ({ c: [b.ct.codigo, b.pagadorNome, b.pagadorDoc, b.pagadorEndereco, b.locadorNome, b.locadorDoc, b.vencimento, b.valorNum, b.linhas[0] || '', b.linhas[1] || '', b.linhas[2] || '', b.instrucoes] }));
  ligarBotoesPDF('bolPdf', async () => {
    const P = novoDocumento(true);
    P.cab();
    tituloPDF(P, `Prévia de boletos - ${mesNum(ym)}`, [[`${boletos.length} boletos · total R$ ${fmtNum(total)}`, 9.5, 'normal', COR_SUAVE]]);
    for (const b of boletos) {
      P.espaco(42);
      subtituloPDF(P, b.referencia, `Vencimento ${b.vencimento}   ·   Valor R$ ${b.valor}`);
      tabelaPDF(P, [{ t: 'Campo', w: 50 }, { t: 'Conteúdo', w: 219 }], [
        { c: ['Pagador (locatário)', `${b.pagadorNome} - CPF/CNPJ ${b.pagadorDoc}`] },
        { c: ['Endereço do pagador', b.pagadorEndereco] },
        { c: ['Locador', `${b.locadorNome} - CPF/CNPJ ${b.locadorDoc}`] },
        ...b.linhas.map((l, j) => ({ c: [`Texto - linha ${j + 1}`, l] })),
        { c: ['Instruções', b.instrucoes] },
      ], 8.5);
    }
    rodapePDF(P);
    return { doc: P.doc, nome: nomeArquivo('previa-boletos', ym) + '.pdf' };
  });
  $('#btBolXlsx')?.addEventListener('click', () => executar(async () => {
    salvarPlanilha(xlsxDeTabela({ titulo: `Prévia de boletos - ${mesNum(ym)}`, linhasTitulo: [`${boletos.length} boletos · total R$ ${fmtNum(total)}`], cols, linhas: linhas(), nomeFolha: 'Boletos' }),
      nomeArquivo('previa-boletos', ym) + '.xlsx');
  }));
}

// Prévia do boleto de um único mês (aberta pela tela do mês do contrato)
function mostrarBoleto(ct, ym, mes, k) {
  const b = dadosBoleto(ct, ym, mes, k);
  abrirModal(`<div class="modal-cab"><h2>Prévia do boleto</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <p class="dica">Copie cada campo e cole no sistema de boletos do banco. Para ver todos os contratos do mês, use <a href="#/boletos?mes=${ym}" data-fechar>Boletos (prévia)</a>.</p>
    <div id="bolModal">${cartaoBoletoHTML(b, 0)}</div>`, 'modal-medio');
  ligarCopiar($('#bolModal'), [b]);
}
