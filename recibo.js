'use strict';
/*
  Recibo de aluguel para o locatário (Lei 8.245/91, art. 22, VI: recibo discriminado, sem quitação genérica).
  Um recibo por folha A4, com o timbre da administradora. A taxa de administração não aparece:
  ela é devida pelo locador à administradora, não pelo locatário.
*/

// Valor em reais por extenso: 1.234,56 → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
function porExtenso(valor) {
  const U = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const DZ = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const CT = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const ate999 = n => {
    if (n === 100) return 'cem';
    const p = [];
    if (n >= 100) { p.push(CT[Math.floor(n / 100)]); n %= 100; }
    if (n >= 20) { p.push(DZ[Math.floor(n / 10)]); n %= 10; }
    if (n) p.push(U[n]);
    return p.join(' e ');
  };
  const inteiro = n => {
    const grupos = [[1e9, 'bilhão', 'bilhões'], [1e6, 'milhão', 'milhões'], [1e3, 'mil', 'mil'], [1, '', '']];
    const partes = [];
    for (const [d, s, pl] of grupos) {
      const q = Math.floor(n / d);
      n %= d;
      if (!q) continue;
      partes.push({ q, d, t: d === 1e3 && q === 1 ? 'mil' : ate999(q) + (s ? ' ' + (q === 1 ? s : pl) : '') });
    }
    return partes.map((p, i) => {
      if (!i) return p.t;
      // "e" antes do último grupo quando ele é menor que 100 ou centena exata (mil e quinhentos, mil e vinte)
      const ultimo = i === partes.length - 1, v = p.q;
      return (ultimo && (v < 100 || v % 100 === 0) ? ' e ' : p.d === 1 || partes[i - 1].d === 1e3 ? ' ' : ', ') + p.t;
    }).join('');
  };
  const c = Math.round(Math.abs(Number(valor) || 0) * 100), reais = Math.floor(c / 100), cents = c % 100;
  const partes = [];
  if (reais) partes.push(inteiro(reais) + (reais % 1e6 === 0 ? ' de' : '') + (reais === 1 ? ' real' : ' reais'));
  if (cents) partes.push(ate999(cents) + (cents === 1 ? ' centavo' : ' centavos'));
  return partes.join(' e ') || 'zero real';
}

const dataExtenso = iso => { const [a, m, d] = iso.split('-').map(Number); return `${d === 1 ? '1º' : d} de ${MESES[m - 1].toLowerCase()} de ${a}`; };
// "CPF/CNPJ nº 123..." (sem repetir o prefixo quando o cadastro já traz "CPF" ou "CNPJ")
const docRecibo = (d, rot = 'CPF/CNPJ') => !d ? '' : /^\s*(cpf|cnpj)/i.test(d) ? d.trim() : `${rot} nº ${d.trim()}`;
const numeroRecibo = (ct, ym) => `${ct.codigo || 's/nº'}-${mesNum(ym)}`;

// Quem pagou: locatário (padrão), fiador ou outra pessoa informada no mês
function pagadorRecibo(ct, mes) {
  const lt = D.locatarios[ct.locatarioId] || { nome: '—' };
  const t = mes.pagador?.tipo;
  const doc = d => d ? ', ' + docRecibo(d) : '';
  if (t === 'fiador' && ct.fiadorNome) return { nome: ct.fiadorNome, texto: `${ct.fiadorNome}${doc(ct.fiadorDocumento)}, na qualidade de fiador do locatário ${lt.nome}${doc(lt.documento)}` };
  if (t === 'fiador2' && ct.fiador2Nome) return { nome: ct.fiador2Nome, texto: `${ct.fiador2Nome}${doc(ct.fiador2Documento)}, na qualidade de fiador do locatário ${lt.nome}${doc(lt.documento)}` };
  if (t === 'outro' && mes.pagador.nome) return { nome: mes.pagador.nome, texto: `${mes.pagador.nome}${doc(mes.pagador.documento)}, por conta do locatário ${lt.nome}${doc(lt.documento)}` };
  return { nome: lt.nome, texto: `${lt.nome}${doc(lt.documento)}, locatário` };
}

// Linhas da discriminação (valores em centavos) e totais do recibo
function dadosRecibo(ct, ym, mes) {
  const sit = situacaoPagto(mes);
  if (sit === 'aberto') throw new Error(`${nomeMes(ym)} não está marcado como pago: não há recibo a emitir.`);
  if (!mes.recebidoEm) throw new Error(`Informe a data do pagamento de ${nomeMes(ym)} para emitir o recibo.`);
  const r = recebimentoMes(mes);
  const linhas = [];
  for (const l of mes.linhas || []) if (cent(l.cobrado)) linhas.push({ d: l.rubrica + (l.obs ? ' (' + l.obs + ')' : ''), v: cent(l.cobrado) });
  for (const a of mes.ajustes || []) if (cent(a.valor)) linhas.push({ d: (a.tipo === 'reembolso' ? '(-) Reembolso' : '(-) Desconto') + (a.descricao ? ': ' + a.descricao : ''), v: -cent(a.valor) });
  const devido = linhas.reduce((s, l) => s + l.v, 0);
  // Multa, juros e correção: separados quando calculados pelo app (e conferem com o total); senão, numa linha só
  const enc = [];
  const det = mes.encargosDetalhe;
  if (r.encargos) {
    const partes = det ? [['Multa por atraso', cent(det.multa)], ['Juros de mora', cent(det.juros)], ['Correção monetária', cent(det.correcao)]] : null;
    const soma = partes ? partes.reduce((s, p) => s + p[1], 0) : 0;
    if (partes && Math.abs(soma - r.encargos) <= 2) {
      partes[2][1] += r.encargos - soma; // arredondamento
      partes.filter(p => p[1]).forEach(p => enc.push({ d: p[0], v: p[1] }));
    } else enc.push({ d: 'Multa, juros e correção monetária por atraso', v: r.encargos });
  }
  return { ct, ym, mes, sit, linhas, devido, principal: r.principal, encargos: enc, total: r.recebido, emAberto: Math.max(0, devido - r.principal), venc: vencimentoMes(ct, ym, mes) };
}

function desenharRecibo(P, R) {
  const { doc } = P, { ct, ym, mes } = R;
  const adm = D.config.administradora || {}, lo = D.locadores[ct.locadorId] || { nome: '—' }, im = D.imoveis[ct.imovelId];
  const pag = pagadorRecibo(ct, mes);
  // Título, número e valor
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...COR_PRI);
  doc.text('RECIBO DE ALUGUEL', P.M, P.y + 6);
  doc.setFontSize(10); doc.setTextColor(...COR_SUAVE);
  doc.text('Nº ' + numeroRecibo(ct, ym), P.M + P.larg, P.y + 2, { align: 'right' });
  doc.setFillColor(...COR_FUNDO); doc.roundedRect(P.M + P.larg - 62, P.y + 4, 62, 11, 1.5, 1.5, 'F');
  doc.setFontSize(14); doc.setTextColor(...COR_PRI);
  doc.text('R$ ' + fmtNum(R.total / 100), P.M + P.larg - 3, P.y + 11.8, { align: 'right' });
  doc.setTextColor(...COR_TEXTO);
  P.y += 22;

  const imovel = im ? descImovel(im) + (im.cep ? ', CEP ' + im.cep : '') : '—';
  const parcial = R.sit === 'parcial';
  const texto = `Recebemos de ${pag.texto}, a importância de R$ ${fmtNum(R.total / 100)} (${porExtenso(R.total / 100)}), `
    + (parcial ? 'como pagamento parcial dos valores' : 'referente ao aluguel e demais encargos')
    + ` do mês de referência ${mesNum(ym)}, com vencimento em ${fmtData(R.venc)}, do imóvel situado em ${imovel}, objeto do contrato de locação nº ${ct.codigo || 's/nº'}, pagamento efetuado em ${fmtData(mes.recebidoEm)}, conforme discriminado abaixo.`;
  paragrafoPDF(P, texto, 10.5);
  P.y += 3;
  const recebedor = `Recebedor: ${lo.nome}${lo.documento ? ', ' + docRecibo(lo.documento) : ''}, locador`
    + (adm.nome ? `, representado por sua administradora e procuradora ${adm.nome}${adm.documento ? ', ' + docRecibo(adm.documento, 'CNPJ/CPF') : ''}${adm.creci ? ', CRECI ' + adm.creci : ''}.` : '.');
  paragrafoPDF(P, recebedor, 10);
  P.y += 5;

  // Discriminação
  subtituloPDF(P, 'Discriminação dos valores');
  const L = R.linhas.map(l => ({ c: [l.d, fmtNum(l.v / 100)] }));
  if (parcial) {
    L.push({ c: ['Total devido no mês', fmtNum(R.devido / 100)], total: true });
    L.push({ c: ['Valor pago nesta data (pagamento parcial)', fmtNum(R.principal / 100)] });
  } else if (R.encargos.length || R.linhas.some(l => l.v < 0)) L.push({ c: ['Subtotal', fmtNum(R.devido / 100)], total: true });
  R.encargos.forEach(e => L.push({ c: [e.d, fmtNum(e.v / 100)] }));
  L.push({ c: ['Total recebido', fmtNum(R.total / 100)], total: true });
  tabelaPDF(P, [{ t: 'Descrição', w: 140 }, { t: 'Valor (R$)', w: 42, a: 'r' }], L, 9.5);
  if (parcial && R.emAberto) { paragrafoPDF(P, `Permanece em aberto, referente a este mês, o valor de R$ ${fmtNum(R.emAberto / 100)}, sem prejuízo dos encargos moratórios.`, 9.5, 'bold'); P.y += 2; }

  // Ressalva de quitação (CC, art. 322)
  paragrafoPDF(P, 'A quitação refere-se exclusivamente aos valores acima discriminados, relativos ao mês de referência indicado, não implicando quitação de débitos anteriores, de diferenças apuradas posteriormente ou de quaisquer outras obrigações decorrentes do contrato de locação.', 8.5, 'italic', COR_SUAVE);
  P.y += 10;

  // Local e data, assinatura (à mão ou eletrônica)
  const cidade = adm.cidade || im?.cidade || '';
  P.espaco(40);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...COR_TEXTO);
  doc.text(`${cidade ? cidade + ', ' : ''}${dataExtenso(mes.recebidoEm)}.`, P.M + P.larg, P.y, { align: 'right' });
  P.y += 24;
  const xm = P.M + P.larg / 2;
  doc.setDrawColor(...COR_TEXTO); doc.setLineWidth(0.3);
  doc.line(xm - 50, P.y, xm + 50, P.y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
  doc.text(adm.nome || lo.nome, xm, P.y + 5, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...COR_SUAVE);
  doc.text(adm.nome ? `Administradora e procuradora de ${lo.nome}` : 'Locador', xm, P.y + 9.5, { align: 'center' });
  if (adm.nome && adm.documento) doc.text(docRecibo(adm.documento, 'CNPJ/CPF') + (adm.creci ? '   ·   CRECI ' + adm.creci : ''), xm, P.y + 13.5, { align: 'center' });
  doc.setTextColor(...COR_TEXTO);
  P.y += 18;
}

// Um ou vários recibos, um por folha. itens: [{ ct, ym, mes }]
function gerarRecibos(itens, nome) {
  if (!window.jspdf) throw new Error('A biblioteca de PDF não foi carregada.');
  if (!itens.length) throw new Error('Nenhum pagamento encontrado para emitir recibo.');
  const dados = itens.map(x => dadosRecibo(x.ct, x.ym, x.mes));
  const P = novoDocumento();
  dados.forEach((R, i) => { if (i) P.doc.addPage(); P.cab(); desenharRecibo(P, R); });
  rodapePDF(P);
  return { doc: P.doc, nome: nome || nomeArquivo('recibo', numeroRecibo(itens[0].ct, itens[0].ym)) + '.pdf' };
}
