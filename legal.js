'use strict';
/* Copyright, licenças de terceiros e Termos de Uso (aceite de cada usuário em cada aparelho) */

const TITULAR = 'Felippe Alvarez';
const ANO_INICIO = 2026;
// TERMOS_VERSAO identifica os Termos: ao alterá-la, todos precisam aceitar de novo.
const TERMOS_VERSAO = '13/10/2026';

const anosCopyright = () => ANO_INICIO + (new Date().getFullYear() > ANO_INICIO ? '–' + new Date().getFullYear() : '');
const versaoInstalada = () => Armaz.infoServidor?.versaoApp || Armaz.versaoApp || '';

function rodapeMenuHTML() {
  return `© ${anosCopyright()} ${esc(TITULAR)}. Todos os direitos reservados.<br>
    Controle de Locações${versaoInstalada() ? ' · versão ' + esc(versaoInstalada()) : ''}<br>
    <a href="#/sobre">Sobre e licenças</a> · <a href="#/termos">Termos de Uso</a>`;
}

const chaveAceite = () => 'cl-termos-' + (Auth.usuario?.login || '');
function aceiteTermos() { try { return JSON.parse(localStorage.getItem(chaveAceite()) || 'null'); } catch { return null; } }
const termosAceitos = () => aceiteTermos()?.versao === TERMOS_VERSAO;

function textoTermosHTML() {
  return `
    <h2>Termos de Uso e Responsabilidades</h2>
    <p class="dica">Versão de ${TERMOS_VERSAO}.</p>
    <p class="destaque">Ao utilizar o aplicativo <b>Controle de Locações</b>, você declara ter lido, compreendido e aceitado integralmente estes Termos. Se não concordar com qualquer disposição, não utilize o aplicativo.</p>

    <h3>1. Objeto</h3>
    <p>O aplicativo é uma ferramenta de apoio à administração de locações de imóveis: cadastros, controle mensal de valores cobrados, recebidos, pagos e repassados, cálculo de débitos, relatórios e prévia de dados para boletos. É disponibilizado <b>“no estado em que se encontra”</b>, sem garantias de qualquer natureza, expressas ou implícitas, inclusive de adequação a uma finalidade específica, de funcionamento ininterrupto ou de ausência de erros.</p>

    <h3>2. Armazenamento dos dados</h3>
    <p>Os dados inseridos são armazenados <b>exclusivamente nos locais escolhidos pelo próprio usuário</b>: no computador que executa o servidor do aplicativo, em pasta da rede, em pasta sincronizada ou em serviço de nuvem por ele indicado. O desenvolvedor <b>não recebe, não armazena, não acessa e não tem meios de recuperar</b> essas informações.</p>

    <h3>3. Proteção de dados pessoais (LGPD)</h3>
    <p>O aplicativo permite o registro de dados pessoais de locadores, locatários e terceiros, como nomes, números de CPF/CNPJ, endereços, contatos e dados bancários. Em relação a esses dados, o <b>usuário (a administradora que utiliza o aplicativo) é o único controlador</b>, nos termos da Lei nº 13.709/2018 (Lei Geral de Proteção de Dados Pessoais – LGPD), cabendo-lhe exclusivamente:</p>
    <ol>
      <li>assegurar a existência de base legal adequada para o tratamento dos dados (art. 7º da LGPD) e utilizá-los apenas para finalidades legítimas, específicas e informadas aos titulares;</li>
      <li>coletar somente os dados necessários à administração das locações;</li>
      <li>atender às solicitações dos titulares (acesso, correção, eliminação e demais direitos previstos no art. 18 da LGPD);</li>
      <li>controlar quem tem acesso: criar um usuário para cada pessoa, com senha própria, desativar quem deixar de precisar do acesso e restringir o acesso às pastas, ao computador do servidor, à rede e aos serviços de nuvem utilizados;</li>
      <li>responder pelo envio e compartilhamento de relatórios, planilhas, cópias de segurança e dados de boletos a terceiros, por qualquer meio;</li>
      <li>eliminar os dados quando cessada a finalidade do tratamento, observados os prazos legais de guarda.</li>
    </ol>
    <p>Como não tem acesso aos dados inseridos, o desenvolvedor <b>não atua como controlador nem como operador</b> desses dados e não responde por seu tratamento, vazamento, perda ou uso indevido.</p>

    <h3>4. Cálculos e conteúdo</h3>
    <p>Saldos, taxas de administração, repasses, reajustes, correção monetária, juros, multas, honorários e demais valores são <b>calculados automaticamente a partir dos dados e parâmetros informados pelo usuário</b> e dos índices obtidos de fonte pública (Banco Central do Brasil), que podem apresentar atrasos, revisões ou indisponibilidade. O usuário é integralmente responsável pela veracidade dos dados inseridos e pela <b>conferência de todos os valores</b> antes de cobrá-los, repassá-los ou utilizá-los. Critérios de cálculo, textos e modelos oferecidos pelo aplicativo não constituem aconselhamento jurídico, contábil ou financeiro e devem ser ajustados ao contrato de locação, à legislação aplicável e às circunstâncias de cada caso.</p>

    <h3>5. Boletos e pagamentos</h3>
    <p>O aplicativo <b>não emite boletos, não registra cobranças e não processa pagamentos</b>. A prévia de boletos apenas reúne dados para conferência e cópia pelo usuário, que é o único responsável pela emissão, pelo conteúdo e pelo registro dos boletos na instituição financeira de sua escolha, cujos termos e tarifas se aplicam.</p>

    <h3>6. Falhas, perda de dados e disponibilidade</h3>
    <p>O aplicativo pode apresentar erros, falhas, incompatibilidades com determinados aparelhos ou navegadores, interrupções e alterações de funcionamento, inclusive em razão de atualizações. Os dados podem ser perdidos, entre outras hipóteses, por defeito, perda, furto ou formatação do computador, exclusão de pastas ou arquivos, falhas da rede ou de serviços de nuvem. <b>É responsabilidade exclusiva do usuário manter cópias de segurança periódicas</b> (função “Exportar backup”, além das cópias automáticas) guardadas fora do computador do servidor, e conferir os relatórios gerados. O funcionamento depende do computador, da rede e dos serviços escolhidos pelo usuário.</p>

    <h3>7. Isenção de responsabilidade</h3>
    <p>Na máxima extensão permitida pela legislação aplicável, <b>o desenvolvedor fica isento de toda e qualquer responsabilidade</b> por danos diretos ou indiretos, materiais ou morais, lucros cessantes, perda de dados, prejuízos decorrentes de falhas, erros de cálculo ou indisponibilidade do aplicativo, bem como por quaisquer consequências do uso dos valores, relatórios, planilhas e dados de boletos, inclusive em cobranças, repasses, negociações, processos administrativos ou judiciais, e por atos do usuário ou de terceiros.</p>

    <h3>8. Serviços e componentes de terceiros</h3>
    <p>O aplicativo pode ser acessado por endereço hospedado no GitHub Pages, que entrega apenas os arquivos do programa (os dados nunca passam por ele). Consulta dados públicos do Banco Central do Brasil (Sistema Gerenciador de Séries Temporais) e pode interagir com serviços de terceiros escolhidos pelo usuário (Dropbox, Google Drive, serviços de rede privada, bancos e outros), regidos por seus próprios termos e políticas, pelos quais o desenvolvedor não responde. Utiliza as bibliotecas jsPDF (licença MIT) e pdf.js (licença Apache 2.0), conforme a página <a href="#/sobre">Sobre e licenças</a>.</p>

    <h3>9. Propriedade intelectual</h3>
    <p>O aplicativo, seu código, layout e textos são de titularidade de ${esc(TITULAR)}. É concedida ao usuário licença gratuita, pessoal, não exclusiva e revogável de uso. É vedado copiar, modificar, redistribuir ou explorar comercialmente o aplicativo sem autorização prévia e por escrito do titular, ressalvados os componentes de terceiros, regidos por suas próprias licenças.</p>

    <h3>10. Alterações destes Termos</h3>
    <p>Estes Termos podem ser alterados a qualquer tempo, com a publicação da nova versão no aplicativo. Quando isso ocorrer, o novo aceite será solicitado a cada usuário.</p>

    <h3>11. Legislação aplicável e foro</h3>
    <p>Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o foro da Comarca da Capital do Estado do Rio de Janeiro (cidade do Rio de Janeiro/RJ) para dirimir quaisquer controvérsias deles decorrentes, ressalvadas as hipóteses em que a lei estabeleça competência diversa.</p>`;
}

// exigirAceite: mostrada após o login, enquanto o usuário não aceitar a versão atual
function telaTermos(exigirAceite = false) {
  if (exigirAceite) document.body.classList.remove('conectado', 'admin', 'menu-aberto');
  const a = aceiteTermos();
  $('#conteudo').innerHTML = `
  ${exigirAceite ? `<p class="alerta caixa-termos">Olá, ${esc(Auth.usuario.nome)}. Antes de começar, leia e aceite os Termos de Uso. Isso é pedido uma única vez em cada aparelho e de novo só quando os Termos forem alterados.</p>` : cabecalho('Termos de Uso')}
  <article class="cartao termos caixa-termos">${textoTermosHTML()}</article>
  ${exigirAceite ? `
  <section class="cartao caixa-termos aceite">
    <label class="inline"><input type="checkbox" id="concordo"> <span>Li e concordo com os <b>Termos de Uso e Responsabilidades</b> acima.</span></label>
    <div class="acoes-linha"><button class="bt primario" id="btAceitar" disabled>Aceitar e continuar</button><button class="bt" id="btRecusar">Sair</button></div>
  </section>` : `<p class="dica caixa-termos">${a?.versao === TERMOS_VERSAO ? `Você aceitou esta versão em ${new Date(a.em).toLocaleString('pt-BR')}.` : ''}</p>`}`;
  window.scrollTo(0, 0);
  if (!exigirAceite) return;
  $('#concordo').addEventListener('change', e => { $('#btAceitar').disabled = !e.target.checked; });
  $('#btAceitar').addEventListener('click', () => executar(async () => {
    try { localStorage.setItem(chaveAceite(), JSON.stringify({ versao: TERMOS_VERSAO, em: new Date().toISOString() })); } catch { /* sem armazenamento: pede de novo na próxima vez */ }
    await conectado();
  }));
  $('#btRecusar').addEventListener('click', () => { Auth.sair(); telaLogin(); });
}

function telaSobre() {
  $('#conteudo').innerHTML = cabecalho('Sobre e licenças') + `
  <section class="cartao caixa-termos">
    <h2>Controle de Locações</h2>
    <dl class="dados">
      <div><dt>Versão</dt><dd>${esc(versaoInstalada() || '—')}</dd></div>
      <div><dt>Titular</dt><dd>${esc(TITULAR)}</dd></div>
      <div><dt>Direitos</dt><dd>© ${anosCopyright()} ${esc(TITULAR)}. Todos os direitos reservados.</dd></div>
    </dl>
    <p class="acoes-linha"><a class="bt" href="manual/index.html" target="_blank" rel="noopener">Manual de uso</a><a class="bt" href="#/termos">Termos de Uso</a></p>
  </section>
  <section class="cartao caixa-termos">
    <h2>Componentes de terceiros</h2>
    <div class="rolagem"><table class="tabela">
      <thead><tr><th>Componente</th><th>Uso no aplicativo</th><th>Licença</th></tr></thead>
      <tbody>
        <tr><td><b>jsPDF</b> 2.5.1<br><span class="dica">© 2010-2021 James Hall, yWorks GmbH e colaboradores</span></td><td>Geração dos relatórios em PDF</td><td><a href="https://github.com/parallax/jsPDF/blob/master/LICENSE" target="_blank" rel="noopener">MIT</a></td></tr>
        <tr><td><b>pdf.js</b> 3.11.174<br><span class="dica">© 2023 Mozilla Foundation</span></td><td>Prévia dos PDFs na tela</td><td><a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener">Apache 2.0</a></td></tr>
        <tr><td><b>Banco Central do Brasil</b> – SGS</td><td>Índices de correção (IGP-M, IPCA, INPC, IGP-DI)</td><td>Dados públicos</td></tr>
      </tbody>
    </table></div>
    <p class="dica">Os avisos de direitos autorais e de licença de cada biblioteca estão preservados nos próprios arquivos, na pasta <code>app/lib</code>. As planilhas Excel e o restante do aplicativo são código próprio.</p>
    <details class="detalhes"><summary>Texto da licença MIT (jsPDF)</summary>
      <p class="licenca">Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:</p>
      <p class="licenca">The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p>
      <p class="licenca">THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p>
    </details>
  </section>`;
}
