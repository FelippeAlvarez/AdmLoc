'use strict';
/* Relatórios em PDF (jsPDF): papel timbrado, tabelas, demonstrativos, prévia e gravação */

const COR_PRI = [31, 78, 121];
const COR_FUNDO = [234, 240, 247];
const COR_TEXTO = [33, 37, 41];
const COR_SUAVE = [100, 108, 118];

// Nos relatórios, meses de referência só em números: MM/AAAA
const mesNum = ym => ym ? ym.slice(5, 7) + '/' + ym.slice(0, 4) : '';
const periodoNum = (de, ate) => de === ate ? mesNum(de) : `${mesNum(de)} a ${mesNum(ate)}`;

function novoDocumento(paisagem) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: paisagem ? 'landscape' : 'portrait' });
  const P = paisagem ? { doc, M: 14, W: 297, H: 210, larg: 269, y: 0, rodape: 16 } : { doc, M: 14, W: 210, H: 297, larg: 182, y: 0, rodape: 16 };
  const adm = D.config.administradora || {};

  // Cabeçalho (papel timbrado) repetido em todas as páginas
  P.cab = () => {
    const top = 9;
    let x = P.M, altLogo = 0;
    if (adm.logo && adm.logoL && adm.logoA) {
      const e = Math.min(40 / adm.logoL, 18 / adm.logoA), w = adm.logoL * e, h = adm.logoA * e;
      try { doc.addImage(adm.logo, adm.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG', x, top, w, h); x += w + 5; altLogo = h; } catch (err) { console.warn(err); }
    }
    const larg = P.W - P.M - x;
    let y = top + 4.8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...COR_PRI);
    doc.text(doc.splitTextToSize(adm.nome || 'Administração de locações', larg)[0], x, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.2); doc.setTextColor(...COR_SUAVE);
    const linhas = [
      [adm.documento, adm.creci && 'CRECI ' + adm.creci].filter(Boolean).join('   ·   '),
      adm.endereco,
      [adm.telefone, adm.email, adm.site].filter(Boolean).join('   ·   '),
    ].filter(Boolean).flatMap(l => doc.splitTextToSize(l, larg));
    linhas.forEach(l => { y += 3.7; doc.text(l, x, y); });
    const fim = Math.max(top + altLogo, y + 1.2) + 2.5;
    doc.setDrawColor(...COR_PRI); doc.setLineWidth(0.5);
    doc.line(P.M, fim, P.W - P.M, fim);
    P.y = fim + 6;
    doc.setTextColor(...COR_TEXTO);
  };
  P.novaPagina = () => { doc.addPage(); P.cab(); };
  P.espaco = h => { if (P.y + h > P.H - P.rodape) P.novaPagina(); };
  return P;
}

/*
  Tabela com ajuste automático das colunas.
  cols: [{ t, w, a: 'r' (direita), nw: true (não quebra) }] — colunas à direita (valores) e "nw" (datas) nunca quebram:
  ganham a largura necessária, tirada das colunas de texto; se mesmo assim não couber, a fonte diminui.
  linhas: [{ c: [...], total, grupo }]
*/
function larguraColunas(P, cols, linhas, fs) {
  const { doc } = P, pad = 1.5;
  const soma = cols.reduce((s, c) => s + c.w, 0);
  const w = cols.map(c => c.w * P.larg / soma);
  const min = cols.map((c, j) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fs - 0.5);
    let m = Math.max(...String(c.t).split(/\s+/).map(p => doc.getTextWidth(p)));
    if (c.a === 'r' || c.nw) {
      for (const ln of linhas) {
        if (ln.grupo) continue;
        doc.setFont('helvetica', ln.total ? 'bold' : 'normal'); doc.setFontSize(fs);
        m = Math.max(m, doc.getTextWidth(String(ln.c[j] ?? '')));
      }
    } else {
      // Colunas de texto quebram entre palavras: a mais longa precisa caber (até 30 mm)
      for (const ln of linhas) {
        if (ln.grupo) continue;
        doc.setFont('helvetica', ln.total ? 'bold' : 'normal'); doc.setFontSize(fs);
        for (const p of String(ln.c[j] ?? '').split(/\s+/)) m = Math.max(m, Math.min(30, doc.getTextWidth(p)));
      }
    }
    return m + 2 * pad + 0.6;
  });
  const falta = w.reduce((s, x, j) => s + Math.max(0, min[j] - x), 0);
  if (!falta) return w;
  const folgas = w.map((x, j) => Math.max(0, x - min[j]));
  const totalFolga = folgas.reduce((s, x) => s + x, 0);
  if (totalFolga < falta) return null;
  return w.map((x, j) => x < min[j] ? min[j] : x - folgas[j] * falta / totalFolga);
}

function tabelaPDF(P, colsIn, linhas, fsMax = 8.5) {
  const { doc } = P;
  let fs = fsMax, larguras = null;
  while (!(larguras = larguraColunas(P, colsIn, linhas, fs)) && fs > 6.5) fs -= 0.5;
  if (!larguras) larguras = colsIn.map(c => c.w * P.larg / colsIn.reduce((s, x) => s + x.w, 0));
  const cols = colsIn.map((c, j) => ({ ...c, w: larguras[j] }));
  const pad = 1.5, lh = fs * 0.3528 * 1.22;
  const quebra = (txt, w, nw) => nw ? [String(txt ?? '')] : doc.splitTextToSize(String(txt ?? ''), w - 2 * pad);
  const escrever = (partes, cs, y) => {
    let x = P.M;
    partes.forEach((p, j) => {
      const c = cs[j];
      p.forEach((t, k) => {
        const ty = y + pad + k * lh + lh * 0.78;
        if (c.a === 'r') doc.text(t, x + c.w - pad, ty, { align: 'right' });
        else if (c.a === 'c') doc.text(t, x + c.w / 2, ty, { align: 'center' });
        else doc.text(t, x + pad, ty);
      });
      x += c.w;
    });
  };
  const desenharCab = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(fs - 0.5);
    const partes = cols.map(c => quebra(c.t, c.w));
    const h = Math.max(...partes.map(p => p.length)) * lh + 2 * pad;
    doc.setFillColor(...COR_PRI); doc.rect(P.M, P.y, P.larg, h, 'F');
    doc.setTextColor(255);
    escrever(partes, cols, P.y);
    P.y += h;
    doc.setTextColor(...COR_TEXTO);
  };

  P.espaco(lh * 4 + 10);
  desenharCab();
  linhas.forEach((ln, i) => {
    const fonte = () => { doc.setFont('helvetica', ln.total || ln.grupo ? 'bold' : (ln.italico ? 'italic' : 'normal')); doc.setFontSize(fs); };
    fonte();
    // Linha de grupo: o primeiro texto ocupa a largura toda da tabela
    const cs = ln.grupo ? [{ w: P.larg }] : cols;
    const partes = ln.grupo ? [quebra(ln.c[0], P.larg)] : ln.c.map((v, j) => quebra(v, cols[j].w, cols[j].a === 'r' || cols[j].nw));
    const h = Math.max(...partes.map(p => p.length)) * lh + 2 * pad;
    if (P.y + h > P.H - P.rodape) { P.novaPagina(); desenharCab(); fonte(); }
    if (ln.total || ln.grupo) { doc.setFillColor(...COR_FUNDO); doc.rect(P.M, P.y, P.larg, h, 'F'); }
    else if (i % 2) { doc.setFillColor(247, 249, 251); doc.rect(P.M, P.y, P.larg, h, 'F'); }
    doc.setTextColor(...(ln.grupo ? COR_PRI : ln.italico ? COR_SUAVE : COR_TEXTO));
    escrever(partes, cs, P.y);
    P.y += h;
    doc.setTextColor(...COR_TEXTO);
    doc.setDrawColor(222, 226, 230); doc.setLineWidth(0.15);
    doc.line(P.M, P.y, P.M + P.larg, P.y);
  });
  P.y += 4;
}

// Linhas "rótulo ....... valor", alinhadas à direita da página; rótulos longos quebram em mais linhas
function resumoPDF(P, itens, larg = 120) {
  const { doc } = P;
  const x0 = P.M + P.larg - larg, lh = 3.6, pad = 0.9;
  const medidas = itens.map(([rot, val, estilo]) => {
    doc.setFont('helvetica', estilo ? 'bold' : 'normal'); doc.setFontSize(8.5);
    const valor = 'R$ ' + fmtNum(val);
    const linhas = doc.splitTextToSize(rot, larg - doc.getTextWidth(valor) - 6);
    return { linhas, valor, h: linhas.length * lh + 2 * pad + (estilo === 'f' ? 0.6 : 0) };
  });
  P.espaco(Math.min(medidas.reduce((s, m) => s + m.h, 0) + 4, P.H - P.rodape - 40));
  itens.forEach(([, , estilo], i) => {
    const { linhas, valor, h } = medidas[i];
    if (P.y + h > P.H - P.rodape) P.novaPagina();
    if (estilo === 'f') { doc.setFillColor(...COR_PRI); doc.rect(x0, P.y, larg, h, 'F'); doc.setTextColor(255); }
    else if (estilo === 'b') { doc.setFillColor(...COR_FUNDO); doc.rect(x0, P.y, larg, h, 'F'); }
    else if (estilo === 'a') doc.setTextColor(179, 38, 30);
    doc.setFont('helvetica', estilo && estilo !== 'a' ? 'bold' : 'normal'); doc.setFontSize(8.5);
    linhas.forEach((l, k) => doc.text(l, x0 + 1.5, P.y + pad + k * lh + 2.8));
    doc.text(valor, x0 + larg - 1.5, P.y + pad + 2.8, { align: 'right' });
    doc.setTextColor(...COR_TEXTO);
    if (!estilo) { doc.setDrawColor(236, 239, 243); doc.setLineWidth(0.1); doc.line(x0, P.y + h, x0 + larg, P.y + h); }
    P.y += h;
  });
  P.y += 4;
}

function paragrafoPDF(P, texto, fs = 8.5, estilo = 'normal', cor = COR_TEXTO) {
  const { doc } = P;
  doc.setFont('helvetica', estilo); doc.setFontSize(fs); doc.setTextColor(...cor);
  const lh = fs * 0.3528 * 1.3;
  for (const l of doc.splitTextToSize(texto, P.larg)) {
    P.espaco(lh);
    doc.text(l, P.M, P.y + lh * 0.8);
    P.y += lh;
  }
  doc.setTextColor(...COR_TEXTO);
}

function subtituloPDF(P, texto, direita) {
  const { doc } = P;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...COR_PRI);
  doc.text(texto, P.M, P.y + 4);
  if (direita) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...COR_SUAVE);
    doc.text(direita, P.M + P.larg, P.y + 4, { align: 'right' });
  }
  doc.setTextColor(...COR_TEXTO);
  P.y += 7;
}

function tituloPDF(P, titulo, linhas = []) {
  const { doc } = P;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...COR_PRI);
  doc.text(titulo, P.M, P.y + 3);
  P.y += 7.5;
  linhas.forEach(([t, fs, est, cor]) => paragrafoPDF(P, t, fs || 9.5, est || 'normal', cor || COR_TEXTO));
  P.y += 4;
}

// Rodapé com data de emissão e numeração
function rodapePDF(P) {
  const { doc } = P;
  const n = doc.getNumberOfPages();
  const agora = new Date();
  const emissao = `Emitido em ${fmtData(hoje())} às ${p2(agora.getHours())}:${p2(agora.getMinutes())}`;
  const adm = D.config.administradora?.nome || '';
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(210); doc.setLineWidth(0.2);
    doc.line(P.M, P.H - 11, P.W - P.M, P.H - 11);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...COR_SUAVE);
    doc.text(emissao, P.M, P.H - 7);
    if (adm) doc.text(adm, P.W / 2, P.H - 7, { align: 'center' });
    doc.text(`Página ${i} de ${n}`, P.W - P.M, P.H - 7, { align: 'right' });
  }
}

const nomeArquivo = (...partes) => partes.join('-').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 90);

/* ================= Demonstrativos ================= */
function blocoContratoPDF(P, ct) {
  const { doc } = P;
  const linhas = [
    'Imóvel: ' + descImovel(D.imoveis[ct.imovelId]),
    `Cliente (locador): ${nomeDe('locadores', ct.locadorId)}   ·   Locatário: ${nomeDe('locatarios', ct.locatarioId)}`,
    `Taxa de administração: ${fmtPct(ct.taxaAdm)}% ${descBase(ct.baseTaxa)}` + (ct.inicio ? `   ·   Vigência: ${[fmtData(ct.inicio), fmtData(ct.fim)].filter(Boolean).join(' a ')}` : ''),
  ];
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  const partes = linhas.flatMap(l => doc.splitTextToSize(l, P.larg - 6));
  const h = 8 + partes.length * 3.9 + 2;
  P.espaco(h + 30);
  doc.setFillColor(...COR_FUNDO); doc.rect(P.M, P.y, P.larg, h, 'F');
  doc.setFillColor(...COR_PRI); doc.rect(P.M, P.y, 1.2, h, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...COR_PRI);
  doc.text(rotuloContrato(ct) + (ct.status === 'encerrado' ? ' (encerrado)' : ''), P.M + 4, P.y + 5.5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...COR_TEXTO);
  partes.forEach((l, i) => doc.text(l, P.M + 4, P.y + 10 + i * 3.9));
  P.y += h + 5;
}

const descPagto = (k, m) => k.diferido ? `${k.situacao === 'parcial' ? 'Pago em parte' : 'Pago pelo locatário'} em ${fmtData(m.recebidoEm)} (em atraso: lançado em ${mesNum(k.diferido.ym)})`
  : k.situacao === 'pago' ? 'Pago pelo locatário' + (m.recebidoEm ? ' em ' + fmtData(m.recebidoEm) : '')
  : k.situacao === 'parcial' ? 'Pago em parte' + (m.recebidoEm ? ' em ' + fmtData(m.recebidoEm) : '')
  : 'Não pago pelo locatário';
const rotuloAjuste = a => (a.tipo === 'reembolso' ? '(-) Reembolso ao locatário' : '(-) Desconto ao locatário') + (a.descricao ? ': ' + a.descricao : '');

function blocoMesPDF(P, x) {
  const m = x.mes, k = x.c, ajustes = m.ajustes || [];
  // Mantém o mês inteiro (tabela + resumo) na mesma página quando ele cabe numa página
  const altura = 7 + ((m.linhas || []).length + ajustes.length + 4) * 5.6 + (11 + 2 * (k.anteriores || []).length + Math.max(1, (m.repasses || []).length)) * 5.5 + 10;
  if (altura < P.H - P.rodape - 40) P.espaco(altura); else P.espaco(40);
  subtituloPDF(P, 'Referência ' + mesNum(x.ym),
    [x.venc ? 'Vencimento ' + fmtData(x.venc) : '', descPagto(k, m), m.fechado ? 'Mês fechado' : 'Mês não fechado'].filter(Boolean).join('   ·   '));
  const linhas = (m.linhas || []).map(l => ({ c: [l.rubrica, l.obs || '', fmtNum(l.cobrado), fmtNum(l.pago)] }));
  if (ajustes.length) {
    linhas.push({ c: ['Subtotal das rubricas', '', fmtNum(k.cobrado), fmtNum(k.pago)], total: true });
    ajustes.forEach(a => linhas.push({ c: [rotuloAjuste(a), a.tipo === 'desconto' ? 'Abate da base da taxa de administração' : '', '-' + fmtNum(a.valor), ''], italico: true }));
    linhas.push({ c: ['Total devido pelo locatário', '', fmtNum(k.devido), fmtNum(k.pago)], total: true });
  } else linhas.push({ c: ['Totais', '', fmtNum(k.cobrado), fmtNum(k.pago)], total: true });
  tabelaPDF(P, [{ t: 'Rubrica', w: 60 }, { t: 'Observação', w: 62 }, { t: 'Cobrado do locatário', w: 30, a: 'r' }, { t: 'Pago pela administradora', w: 30, a: 'r' }], linhas);
  if (m.reajuste?.pct !== undefined) {
    paragrafoPDF(P, `Reajuste anual aplicado neste mês: ${fmtPct(m.reajuste.pct)}% (${m.reajuste.indice}${m.reajuste.de ? ' acumulado de ' + mesNum(m.reajuste.de) + ' a ' + mesNum(m.reajuste.ate) : ''}).`, 8, 'italic', COR_SUAVE);
    P.y += 2;
  }
  const reps = (m.repasses || []).map(r => [`(-) Repasse ao cliente em ${fmtData(r.data)}${r.obs ? ' - ' + r.obs : ''}`, r.valor]);
  const anteriores = (k.anteriores || []).map(v => v.cobranca ? [`(+) ${v.desc}`, v.recebido] : [`(+) Recebido em ${fmtData(v.recebidoEm)}, referente a ${mesNum(v.ym)} (pagamento em atraso${v.encargos ? `; inclui multa, juros e correção de R$ ${fmtNum(v.encargos)}` : ''})`, v.recebido]);
  resumoPDF(P, [
    ['Saldo anterior (não repassado)', k.saldoAnterior],
    ['Total devido pelo locatário no mês', k.devido],
    [k.diferido ? `(+) Recebido do locatário neste mês (pago em ${fmtData(k.diferido.recebidoEm)}: R$ ${fmtNum(k.diferido.recebido)}, lançado na prestação de contas de ${mesNum(k.diferido.ym)})` : '(+) Recebido do locatário', k.principalRecebido],
    ...(k.encargosRecebidos ? [['(+) Multa, juros e correção recebidos', k.encargosRecebidos]] : []),
    ...anteriores,
    ['(-) Total pago pela administradora', k.pago],
    ['(=) Saldo líquido do mês', k.liquido, 'b'],
    [`(-) Taxa de administração: ${fmtPct(m.taxaAdm)}% sobre ${m.baseTaxa === 'total' ? 'o total recebido' : 'a locação recebida'} (base ${fmtNum(k.baseTaxa)})`, k.taxaMes],
    ...(anteriores.length ? [['(-) Taxa de administração sobre os recebimentos de meses anteriores e de débitos em atraso', k.taxaAnteriores]] : []),
    ['(=) Saldo do mês', k.saldoMes, 'b'],
    ['Disponível para repasse', k.disponivel],
    ...(reps.length ? reps : [['(-) Repassado ao cliente', 0]]),
    ['(=) Saldo em conta', k.saldoConta, 'f'],
    ...(k.emAberto ? [['Não pago pelo locatário (em aberto)', k.emAberto, 'a']] : []),
  ]);
  if (m.obs) { paragrafoPDF(P, 'Observações: ' + m.obs, 8, 'italic', COR_SUAVE); P.y += 3; }
}

function resumoPeriodoPDF(P, meses, titulo) {
  P.espaco(30);
  subtituloPDF(P, titulo, `Saldo anterior em ${mesNum(meses[0].ym)}: R$ ${fmtNum(meses[0].c.saldoAnterior)}`);
  const soma = k => meses.reduce((s, x) => s + cent(x.c[k]), 0) / 100;
  tabelaPDF(P,
    [{ t: 'Referência', w: 20, nw: true }, { t: 'Devido pelo locatário', w: 23, a: 'r' }, { t: 'Recebido do locatário', w: 23, a: 'r' }, { t: 'Pago pela administradora', w: 25, a: 'r' },
      { t: 'Taxa de administração', w: 24, a: 'r' }, { t: 'Saldo do mês', w: 22, a: 'r' }, { t: 'Repassado ao cliente', w: 22, a: 'r' }, { t: 'Saldo em conta', w: 23, a: 'r' }],
    [...meses.map(x => ({ c: [mesNum(x.ym), fmtNum(x.c.devido), fmtNum(x.c.recebido), fmtNum(x.c.pago), fmtNum(x.c.taxa), fmtNum(x.c.saldoMes), fmtNum(x.c.repassado), fmtNum(x.c.saldoConta)] })),
      { c: ['Totais', fmtNum(soma('devido')), fmtNum(soma('recebido')), fmtNum(soma('pago')), fmtNum(soma('taxa')), fmtNum(soma('saldoMes')), fmtNum(soma('repassado')), fmtNum(meses[meses.length - 1].c.saldoConta)], total: true }], 8);
}

function repassesPeriodoPDF(P, meses) {
  const reps = meses.flatMap(x => (x.mes.repasses || []).map(r => ({ ...r, ym: x.ym }))).sort((a, b) => comparar(a.data, b.data));
  if (!reps.length) return;
  P.espaco(24);
  subtituloPDF(P, 'Repasses ao cliente no período');
  tabelaPDF(P, [{ t: 'Data', w: 24, nw: true }, { t: 'Referência', w: 24, nw: true }, { t: 'Observação', w: 104 }, { t: 'Valor', w: 30, a: 'r' }],
    [...reps.map(r => ({ c: [fmtData(r.data), mesNum(r.ym), r.obs || '', fmtNum(r.valor)] })),
      { c: ['Total', '', '', fmtNum(reps.reduce((s, r) => s + cent(r.valor), 0) / 100)], total: true }], 8);
}

function consolidadoPDF(P, blocos) {
  P.espaco(30);
  subtituloPDF(P, 'Resumo consolidado do período');
  const soma = (ms, k) => ms.reduce((s, x) => s + cent(x.c[k]), 0);
  const chaves = ['devido', 'recebido', 'pago', 'taxa', 'repassado'];
  const tot = Object.fromEntries([...chaves, 'conta'].map(k => [k, 0]));
  const linhas = blocos.map(({ ct, meses }) => {
    const v = Object.fromEntries(chaves.map(k => [k, soma(meses, k)]));
    v.conta = cent(meses[meses.length - 1].c.saldoConta);
    Object.keys(tot).forEach(k => { tot[k] += v[k]; });
    return { c: [ct.codigo, descImovel(D.imoveis[ct.imovelId]), ...[...chaves, 'conta'].map(k => fmtNum(v[k] / 100))] };
  });
  tabelaPDF(P,
    [{ t: 'Contrato', w: 15, nw: true }, { t: 'Imóvel', w: 47 }, { t: 'Devido pelo locatário', w: 20, a: 'r' }, { t: 'Recebido do locatário', w: 20, a: 'r' }, { t: 'Pago pela administradora', w: 21, a: 'r' },
      { t: 'Taxa de administração', w: 20, a: 'r' }, { t: 'Repassado ao cliente', w: 20, a: 'r' }, { t: 'Saldo em conta (final)', w: 20, a: 'r' }],
    [...linhas, { c: ['Totais', '', ...[...chaves, 'conta'].map(k => fmtNum(tot[k] / 100))], total: true }], 8);
}

async function gerarRelatorio(op) {
  if (!window.jspdf) throw new Error('A biblioteca de PDF não foi carregada.');
  let { de, ate } = op;
  if (de > ate) [de, ate] = [ate, de];

  let contratos, titulo, subtitulo;
  if (op.tipo === 'contrato') {
    const ct = D.contratos[op.id];
    if (!ct) throw new Error('Contrato não encontrado.');
    contratos = [ct];
    titulo = 'Demonstrativo de locação';
    subtitulo = rotuloContrato(ct) + ' - ' + descImovel(D.imoveis[ct.imovelId]);
  } else if (op.tipo === 'imovel') {
    const im = D.imoveis[op.id];
    if (!im) throw new Error('Imóvel não encontrado.');
    contratos = Object.values(D.contratos).filter(c => c.imovelId === op.id);
    titulo = 'Demonstrativo do imóvel';
    subtitulo = rotuloImovel(im) + '   ·   Cliente: ' + nomeDe('locadores', im.locadorId);
  } else {
    const lo = D.locadores[op.id];
    if (!lo) throw new Error('Cliente não encontrado.');
    contratos = Object.values(D.contratos).filter(c => c.locadorId === op.id);
    titulo = 'Demonstrativo do cliente';
    subtitulo = lo.nome + (lo.documento ? '   ·   CPF/CNPJ ' + lo.documento : '');
  }
  contratos.sort(ordemContrato);

  const blocos = [];
  for (const ct of contratos) {
    const ext = await carregarExtrato(ct.id);
    const meses = calcularExtrato(ct, ext).filter(x => x.ym >= de && x.ym <= ate).map(x => ({ ...x, venc: vencimentoMes(ct, x.ym, x.mes) }));
    if (meses.length) blocos.push({ ct, meses });
  }
  if (!blocos.length) throw new Error(`Não há meses lançados entre ${mesNum(de)} e ${mesNum(ate)} para a seleção escolhida.`);

  const P = novoDocumento();
  P.cab();
  const linhasTitulo = [[subtitulo, 10, 'bold'], ['Período de referência: ' + periodoNum(de, ate), 9.5, 'normal', COR_SUAVE]];
  if (op.tipo === 'locador') {
    const lo = D.locadores[op.id];
    const banco = [lo.favorecido && 'Favorecido: ' + lo.favorecido, lo.banco && 'Banco ' + lo.banco, lo.agencia && 'Agência ' + lo.agencia, lo.conta && 'Conta ' + lo.conta, lo.pix && 'PIX ' + lo.pix].filter(Boolean).join('   ·   ');
    if (banco) linhasTitulo.push(['Dados para repasse: ' + banco, 8.5, 'normal', COR_SUAVE]);
  }
  tituloPDF(P, titulo, linhasTitulo);
  P.y += 1;

  for (const { ct, meses } of blocos) {
    blocoContratoPDF(P, ct);
    if (op.detalhado) meses.forEach(x => blocoMesPDF(P, x));
    if (!op.detalhado || meses.length > 1) resumoPeriodoPDF(P, meses, op.detalhado ? 'Resumo do período' : 'Movimento mês a mês');
    if (!op.detalhado) repassesPeriodoPDF(P, meses);
    P.y += 3;
  }
  if (blocos.length > 1) consolidadoPDF(P, blocos);
  rodapePDF(P);

  const alvo = op.tipo === 'contrato' ? 'contrato-' + contratos[0].codigo
    : op.tipo === 'imovel' ? 'imovel-' + (D.imoveis[op.id].codigo || D.imoveis[op.id].logradouro)
    : 'cliente-' + D.locadores[op.id].nome;
  return { doc: P.doc, nome: nomeArquivo('demonstrativo', alvo, de === ate ? de : de + '_a_' + ate) + '.pdf' };
}

/* ================= Prévia e gravação ================= */
let pdfjsPronto = null;
function carregarPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  pdfjsPronto = pdfjsPronto || new Promise((ok, falha) => {
    const s = document.createElement('script');
    s.src = 'lib/pdf.min.js';
    s.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js'; ok(); };
    s.onerror = () => { pdfjsPronto = null; falha(new Error('Não foi possível carregar o visualizador de PDF.')); };
    document.head.appendChild(s);
  });
  return pdfjsPronto;
}

// Salva escolhendo a pasta (Chrome/Edge no computador) ou, se não der, na pasta Downloads
async function salvarArquivo(blob, nome, tipo) {
  if (window.showSaveFilePicker) {
    try {
      const ext = nome.split('.').pop();
      const h = await window.showSaveFilePicker({
        suggestedName: nome, id: 'cl-relatorios',
        types: [{ description: ext === 'pdf' ? 'Documento PDF' : 'Planilha do Excel', accept: { [tipo]: ['.' + ext] } }],
      });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      aviso('Arquivo salvo: ' + h.name);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Gravação com escolha de pasta indisponível; usando Downloads.', e);
    }
  }
  baixar(blob, nome);
  aviso('Arquivo salvo na pasta de downloads: ' + nome);
}

const salvarPDF = ({ doc, nome }) => salvarArquivo(doc.output('blob'), nome, 'application/pdf');
const salvarPlanilha = (blob, nome) => salvarArquivo(blob, nome, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

// Prévia do PDF numa janela sobre a tela (funciona também no celular)
async function visualizarPDF({ doc, nome }) {
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const arquivo = new File([blob], nome, { type: 'application/pdf' });
  const compartilhar = navigator.canShare?.({ files: [arquivo] });
  abrirModal(`<div class="modal-cab"><h2>Prévia do relatório</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    ${D.config.administradora?.nome ? '' : '<p class="alerta">Os dados da administradora ainda não foram preenchidos e não aparecem no cabeçalho. O administrador pode preenchê-los em <a href="#/admin" data-fechar>Administração</a>.</p>'}
    <div class="barra-previa"><span class="dica">${esc(nome)}</span><span class="espaco"></span>
      <button class="bt primario" id="pvSalvar">Salvar PDF</button>
      ${compartilhar ? '<button class="bt" id="pvCompartilhar">Compartilhar</button>' : ''}
      <a class="bt" href="${url}" target="_blank" rel="noopener">Abrir em nova aba</a></div>
    <div class="previa" id="previa"><p class="carregando">Preparando a prévia…</p></div>`, 'modal-grande');
  $('#pvSalvar').addEventListener('click', () => executar(() => salvarArquivo(blob, nome, 'application/pdf')));
  $('#pvCompartilhar')?.addEventListener('click', () => navigator.share({ files: [arquivo], title: nome }).catch(() => {}));
  const area = $('#previa');
  try {
    await carregarPdfJs();
    const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    area.innerHTML = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      if (!document.body.contains(area)) return; // a janela foi fechada
      const pg = await pdf.getPage(i);
      const base = pg.getViewport({ scale: 1 });
      const escala = Math.min(2.5, (area.clientWidth - 24) / base.width * (window.devicePixelRatio || 1));
      const vp = pg.getViewport({ scale: escala });
      const cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      cv.className = 'pagina-pdf';
      area.appendChild(cv);
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
  } catch (e) {
    console.warn(e);
    area.innerHTML = `<iframe class="previa-pdf" src="${url}" title="Prévia do PDF"></iframe>`;
  }
}

// Compatibilidade com as chamadas antigas
const mostrarPDF = visualizarPDF;

// Botões "Visualizar" e "Salvar PDF" lado a lado
const botoesPDF = (id, rotulo = 'PDF') => `<button class="bt" id="${id}Ver">Visualizar ${rotulo}</button><button class="bt" id="${id}Salvar">Salvar ${rotulo}</button>`;
function ligarBotoesPDF(id, gerar) {
  $('#' + id + 'Ver')?.addEventListener('click', () => executar(async () => visualizarPDF(await gerar())));
  $('#' + id + 'Salvar')?.addEventListener('click', () => executar(async () => salvarPDF(await gerar())));
}
