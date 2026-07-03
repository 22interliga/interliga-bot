/**
 * frete-bot-handler.js
 *
 * Módulo de fluxo de FRETE (agenciamento de carretas) para reaproveitar o mesmo
 * número/sessão WhatsApp do interliga-bot (Baileys), sem misturar lógica com o
 * fluxo de corridas urbanas do Interliga.
 *
 * COMO INTEGRAR no seu serviço Railway existente (interliga-bot):
 *
 *   const { handleFreteMessage, watchDisparos, iniciarExpiracaoAutomatica } = require('./frete-bot-handler');
 *
 *   // dentro do listener de mensagens do Baileys (sock.ev.on('messages.upsert', ...)):
 *   const telefone = jidNormalize(msg.key.remoteJid); // só dígitos
 *   const tratado = await handleFreteMessage(sock, telefone, textoDaMensagem, db);
 *   if (tratado) return; // se o fluxo de frete já respondeu, não passa pro handler do Interliga
 *
 *   // uma única vez, ao iniciar o serviço (depois do sock estar conectado):
 *   watchDisparos(sock, db);
 *   iniciarExpiracaoAutomatica(db); // desativa disponibilidade depois de 24h parado
 *
 * "db" é uma instância do firebase-admin Firestore (admin.firestore()).
 * Requer: npm install firebase-admin (provavelmente já instalado no projeto).
 */

const REGIOES = {
  '1': 'Norte',
  '2': 'Nordeste',
  '3': 'Centro-Oeste',
  '4': 'Sudeste',
  '5': 'Sul',
  '6': 'Qualquer regiao',
};

// ---------- Reconhecimento de palavras-chave de disponibilidade ----------
// Qualquer mensagem que CONTENHA um destes termos já é entendida como
// "estou disponível" — não precisa ser a frase exata nem uma palavra isolada.
const PALAVRAS_DISPONIBILIDADE = [
  'oi', 'oii', 'oie', 'ola', 'olá',
  'bom dia', 'boa tarde', 'boa noite',
  'disponivel', 'disponível', 'to disponivel', 'tô disponível',
  'livre', 'to livre', 'tô livre',
  'falar com agenciador', 'quero falar com agenciador',
  'tem carga', 'carga disponivel', 'carga disponível',
];

// Janela de disponibilidade automática: depois desse tempo sem sinalização,
// o motorista volta sozinho pra "indisponível".
const HORAS_EXPIRACAO_DISPONIBILIDADE = 24;

function estaSinalizandoDisponibilidade(mensagem) {
  const texto = (mensagem || '').toLowerCase().trim();
  if (!texto) return false;
  return PALAVRAS_DISPONIBILIDADE.some((palavra) => texto.includes(palavra));
}

function menuRegioes() {
  return (
    'Para qual região você prefere fretes?\n\n' +
    '1 - Norte\n2 - Nordeste\n3 - Centro-Oeste\n4 - Sudeste\n5 - Sul\n6 - Qualquer região\n\n' +
    'Responda só com o número.'
  );
}

function menuDisponibilidade() {
  return (
    'Olá! Você está disponível para frete agora?\n\n' +
    '1 - Sim, disponível\n2 - Não disponível\n\n' +
    'Responda só com o número.'
  );
}

async function enviarTexto(sock, telefone, texto) {
  const jid = telefone.includes('@') ? telefone : `${telefone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: texto });
}

/**
 * Processa qualquer mensagem recebida de um número.
 * Retorna true se a mensagem foi tratada pelo fluxo de frete (e portanto não deve
 * ser repassada ao handler do Interliga urbano).
 */
async function handleFreteMessage(sock, telefoneRaw, textoRaw, db) {
  const telefone = telefoneRaw.replace(/\D/g, '');
  const texto = (textoRaw || '').trim();

  const motoristaRef = db.collection('frete_motoristas').doc(telefone);
  const motoristaSnap = await motoristaRef.get();

  // Número não cadastrado como motorista de frete -> não é deste fluxo.
  if (!motoristaSnap.exists) return false;

  const motorista = motoristaSnap.data();

  if (motorista.status !== 'aprovado') {
    await enviarTexto(
      sock,
      telefone,
      'Seu cadastro de motorista ainda está em análise. Em breve entraremos em contato.'
    );
    return true;
  }

  const sessionRef = db.collection('frete_sessions').doc(telefone);
  const sessionSnap = await sessionRef.get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;

  // --- 1. Aguardando resposta de ACEITE de uma carga específica ---
  if (session && session.step === 'aguardando_aceite' && session.cargaId) {
    if (texto === '1') {
      await processarAceite(sock, db, telefone, motorista, session.cargaId, sessionRef);
      return true;
    }
    if (texto === '2') {
      await db.collection('frete_cargas').doc(session.cargaId).update({
        recusadoPor: (
          (await db.collection('frete_cargas').doc(session.cargaId).get()).data().recusadoPor || []
        ).concat(telefone),
      });
      await sessionRef.delete();
      await enviarTexto(sock, telefone, 'Tudo bem, carga recusada. Avisaremos na próxima disponível.');
      return true;
    }
    await enviarTexto(
      sock,
      telefone,
      'Não entendi. Responda apenas:\n1 - Aceitar\n2 - Recusar'
    );
    return true;
  }

  // --- 2. Aguardando escolha de REGIÃO ---
  if (session && session.step === 'aguardando_regiao') {
    const regiao = REGIOES[texto];
    if (!regiao) {
      await enviarTexto(sock, telefone, 'Opção inválida.\n\n' + menuRegioes());
      return true;
    }
    await motoristaRef.update({
      disponivel: true,
      regiaoInteresse: regiao,
      disponivelDesde: new Date(), // usado pra expiração automática de 24h
    });
    await sessionRef.delete();
    await enviarTexto(
      sock,
      telefone,
      `Pronto! Você está marcado como DISPONÍVEL para fretes em direção a: ${regiao}.\n\n` +
        `Avisaremos por aqui quando surgir uma carga compatível. Se ficar indisponível, é só me avisar quando quiser — ` +
        `senão, sua disponibilidade expira sozinha depois de ${HORAS_EXPIRACAO_DISPONIBILIDADE}h sem contato.`
    );
    return true;
  }

  // --- 3. Aguardando resposta de DISPONIBILIDADE (menu numérico) ---
  if (session && session.step === 'aguardando_disponibilidade') {
    if (texto === '1') {
      await sessionRef.set({ step: 'aguardando_regiao', updatedAt: new Date() });
      await enviarTexto(sock, telefone, menuRegioes());
      return true;
    }
    if (texto === '2') {
      await motoristaRef.update({ disponivel: false, regiaoInteresse: null, disponivelDesde: null });
      await sessionRef.delete();
      await enviarTexto(sock, telefone, 'Ok, você está marcado como INDISPONÍVEL. Quando quiser avisar disponibilidade, é só mandar uma mensagem aqui.');
      return true;
    }
    await enviarTexto(sock, telefone, 'Não entendi.\n\n' + menuDisponibilidade());
    return true;
  }

  // --- 4. Sem sessão ativa ---
  // Se a mensagem já veio com uma palavra-chave de disponibilidade
  // ("oi", "bom dia", "disponível", "tem carga", etc.), pula direto pro
  // menu de região — não precisa perguntar "1 ou 2" de novo.
  if (estaSinalizandoDisponibilidade(texto)) {
    await sessionRef.set({ step: 'aguardando_regiao', updatedAt: new Date() });
    await enviarTexto(
      sock,
      telefone,
      'Boa! Anotado que você está disponível. ' + menuRegioes()
    );
    return true;
  }

  // Qualquer outra mensagem que não bateu com palavra-chave: fluxo padrão.
  await sessionRef.set({ step: 'aguardando_disponibilidade', updatedAt: new Date() });
  await enviarTexto(sock, telefone, menuDisponibilidade());
  return true;
}

/**
 * Tenta atribuir a carga ao motorista que respondeu "1", usando transação para
 * evitar que dois motoristas aceitem a mesma carga ao mesmo tempo.
 */
async function processarAceite(sock, db, telefone, motorista, cargaId, sessionRef) {
  const cargaRef = db.collection('frete_cargas').doc(cargaId);
  let resultado;

  await db.runTransaction(async (tx) => {
    const cargaDoc = await tx.get(cargaRef);
    if (!cargaDoc.exists) {
      resultado = 'inexistente';
      return;
    }
    const carga = cargaDoc.data();
    if (carga.status !== 'aberta') {
      resultado = 'ja_atribuida';
      return;
    }
    tx.update(cargaRef, {
      status: 'aceita',
      motoristaId: telefone,
      motoristaNome: motorista.nome,
    });
    resultado = 'ok';
  });

  await sessionRef.delete();

  if (resultado === 'inexistente') {
    await enviarTexto(sock, telefone, 'Essa carga não está mais disponível.');
    return;
  }

  if (resultado === 'ja_atribuida') {
    await enviarTexto(sock, telefone, 'Essa carga já foi atribuída a outro motorista. Fique atento às próximas.');
    return;
  }

  // resultado === 'ok' -> avisa o motorista vencedor com dados de pagamento
  // Carga aceita marca o motorista como indisponível até ele sinalizar de novo.
  await db.collection('frete_motoristas').doc(telefone).update({
    disponivel: false,
    disponivelDesde: null,
  });

  const pixSnap = await db.collection('frete_config').doc('geral').get();
  const pixKey = pixSnap.exists ? pixSnap.data().pixKey : '(configure a chave Pix no painel)';
  const cargaDoc = await cargaRef.get();
  const carga = cargaDoc.data();

  await enviarTexto(
    sock,
    telefone,
    `✅ Carga confirmada!\n\n` +
      `Transportadora: ${carga.transportadora}\n` +
      `Origem: ${carga.origem}\nDestino: ${carga.destino}\n\n` +
      `Taxa de agenciamento: R$ ${carga.taxa}\n` +
      `Chave Pix: ${pixKey}\n\n` +
      `Por favor, envie o comprovante de pagamento aqui mesmo neste WhatsApp.`
  );

  // Avisa os demais motoristas que foram chamados que a carga já foi atribuída
  const outros = (carga.offeredTo || []).filter((id) => id !== telefone);
  for (const idOutro of outros) {
    const outraSessionRef = db.collection('frete_sessions').doc(idOutro);
    const outraSessao = await outraSessionRef.get();
    if (outraSessao.exists && outraSessao.data().cargaId === cargaId) {
      await outraSessionRef.delete();
      await enviarTexto(idOutro, 'Essa carga já foi atribuída a outro motorista. Obrigado por responder rápido — fique atento às próximas.');
    }
  }
}

/**
 * Escuta a coleção 'frete_disparos' (criada pelo painel admin quando uma carga
 * é cadastrada/disparada) e envia a mensagem da carga para os motoristas
 * compatíveis listados em motoristasIds.
 *
 * Chame esta função UMA VEZ ao iniciar o serviço, depois que o sock Baileys
 * já estiver conectado.
 */
function watchDisparos(sock, db) {
  db.collection('frete_disparos')
    .where('processado', '==', false)
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        const disparo = change.doc.data();
        await processarDisparo(sock, db, change.doc.id, disparo);
      }
    });
}

async function processarDisparo(sock, db, disparoId, disparo) {
  const cargaSnap = await db.collection('frete_cargas').doc(disparo.cargaId).get();
  if (!cargaSnap.exists) {
    await db.collection('frete_disparos').doc(disparoId).update({ processado: true });
    return;
  }
  const carga = cargaSnap.data();

  const mensagem =
    `📦 Carga disponível!\n\n` +
    `Transportadora: ${carga.transportadora}\n` +
    `Origem: ${carga.origem}\n` +
    `Destino: ${carga.destino}\n` +
    `Tipo de carga: ${carga.tipoCarga}\n` +
    `Peso/Volume: ${carga.peso || '-'}\n` +
    `Tipo de carreta exigida: ${carga.tipoCarretaExigida}\n` +
    `Data de coleta: ${carga.dataColeta}\n` +
    `Taxa de agenciamento: R$ ${carga.taxa}\n\n` +
    `1 - Aceitar\n2 - Recusar`;

  for (const telefone of disparo.motoristasIds) {
    await enviarTexto(sock, telefone, mensagem);
    await db.collection('frete_sessions').doc(telefone).set({
      step: 'aguardando_aceite',
      cargaId: disparo.cargaId,
      updatedAt: new Date(),
    });
  }

  await db.collection('frete_disparos').doc(disparoId).update({ processado: true });
}

/**
 * Verifica periodicamente os motoristas marcados como disponíveis e desativa
 * quem passou de HORAS_EXPIRACAO_DISPONIBILIDADE sem sinalizar de novo.
 * Isso evita disparar carga pra quem já saiu com outro frete e esqueceu de avisar.
 *
 * Chame UMA VEZ ao iniciar o serviço, junto com watchDisparos().
 */
function iniciarExpiracaoAutomatica(db, intervaloMs = 60 * 60 * 1000) {
  async function checarExpiracoes() {
    const limite = new Date(Date.now() - HORAS_EXPIRACAO_DISPONIBILIDADE * 60 * 60 * 1000);

    const snap = await db
      .collection('frete_motoristas')
      .where('disponivel', '==', true)
      .where('disponivelDesde', '<=', limite)
      .get();

    const batch = db.batch();
    snap.forEach((doc) => {
      batch.update(doc.ref, { disponivel: false, regiaoInteresse: null, disponivelDesde: null });
    });
    if (!snap.empty) {
      await batch.commit();
      console.log(`[frete] ${snap.size} motorista(s) expirado(s) por inatividade (>${HORAS_EXPIRACAO_DISPONIBILIDADE}h).`);
    }
  }

  checarExpiracoes(); // roda uma vez já na inicialização
  setInterval(checarExpiracoes, intervaloMs); // e depois a cada intervaloMs (padrão: 1h)
}

module.exports = { handleFreteMessage, watchDisparos, iniciarExpiracaoAutomatica };
