/**
 * frete-bot-handler.js
 * Módulo de frete (agenciamento de carretas) para o interliga-bot (Baileys).
 * Inclui fluxo de autocadastro de motoristas via WhatsApp.
 */

const REGIOES = {
  '1': 'Norte',
  '2': 'Nordeste',
  '3': 'Centro-Oeste',
  '4': 'Sudeste',
  '5': 'Sul',
  '6': 'Qualquer região',
};

const TIPOS_CARRETA = {
  '1': 'Graneleira',
  '2': 'Sider',
  '3': 'Baú',
  '4': 'Prancha',
  '5': 'Caçamba',
};

async function enviarTexto(sock, telefone, texto) {
  const jid = telefone.includes('@') ? telefone : `${telefone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: texto });
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
    'Você está disponível para frete agora?\n\n' +
    '1 - Sim, disponível\n2 - Não disponível\n\n' +
    'Responda só com o número.'
  );
}

// ── FLUXO DE AUTOCADASTRO ──────────────────────────────────────────────────

async function iniciarCadastro(sock, telefone, db) {
  const sessionRef = db.collection('frete_sessions').doc(telefone);
  await sessionRef.set({ step: 'cadastro_nome', updatedAt: new Date() });
  await enviarTexto(sock, telefone,
    '🚛 *Bem-vindo ao sistema de agenciamento de frete!*\n\n' +
    'Vou fazer seu cadastro agora. É rápido!\n\n' +
    '👤 Qual é o seu *nome completo*?'
  );
}

async function processarCadastro(sock, telefone, texto, session, db) {
  const sessionRef = db.collection('frete_sessions').doc(telefone);
  const dados = session.dadosCadastro || {};

  switch (session.step) {

    case 'cadastro_nome':
      dados.nome = texto;
      await sessionRef.set({ step: 'cadastro_tipoCarreta', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ Nome: *${texto}*\n\n` +
        '🚚 Qual o *tipo da sua carreta*?\n\n' +
        '1 - Graneleira\n2 - Sider\n3 - Baú\n4 - Prancha\n5 - Caçamba\n\n' +
        'Responda só com o número.'
      );
      break;

    case 'cadastro_tipoCarreta':
      if (!TIPOS_CARRETA[texto]) {
        await enviarTexto(sock, telefone, 'Opção inválida. Digite 1, 2, 3, 4 ou 5.');
        return;
      }
      dados.tipoCarreta = TIPOS_CARRETA[texto];
      await sessionRef.set({ step: 'cadastro_capacidade', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ Carreta: *${dados.tipoCarreta}*\n\n` +
        '⚖️ Qual a *capacidade* da sua carreta em toneladas?\n_(Ex: 28)_'
      );
      break;

    case 'cadastro_capacidade':
      dados.capacidade = Number(texto) || 0;
      await sessionRef.set({ step: 'cadastro_rntrc', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ Capacidade: *${dados.capacidade}t*\n\n` +
        '📋 Qual o número do seu *RNTRC (ANTT)*?'
      );
      break;

    case 'cadastro_rntrc':
      dados.rntrc = texto;
      await sessionRef.set({ step: 'cadastro_cnhE', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ RNTRC: *${texto}*\n\n` +
        '🪪 Você possui *CNH categoria E*?\n\n1 - Sim\n2 - Não'
      );
      break;

    case 'cadastro_cnhE':
      if (texto !== '1' && texto !== '2') {
        await enviarTexto(sock, telefone, 'Digite 1 para Sim ou 2 para Não.');
        return;
      }
      dados.cnhE = texto === '1';
      await sessionRef.set({ step: 'cadastro_crlvCavalo', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ CNH-E: *${dados.cnhE ? 'Sim' : 'Não'}*\n\n` +
        '📄 O *CRLV do cavalo* está em dia?\n\n1 - Sim\n2 - Não'
      );
      break;

    case 'cadastro_crlvCavalo':
      if (texto !== '1' && texto !== '2') {
        await enviarTexto(sock, telefone, 'Digite 1 para Sim ou 2 para Não.');
        return;
      }
      dados.crlvCavalo = texto === '1';
      await sessionRef.set({ step: 'cadastro_crlvCarreta', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ CRLV Cavalo: *${dados.crlvCavalo ? 'Sim' : 'Não'}*\n\n` +
        '📄 O *CRLV da carreta* está em dia?\n\n1 - Sim\n2 - Não'
      );
      break;

    case 'cadastro_crlvCarreta':
      if (texto !== '1' && texto !== '2') {
        await enviarTexto(sock, telefone, 'Digite 1 para Sim ou 2 para Não.');
        return;
      }
      dados.crlvCarreta = texto === '1';
      await sessionRef.set({ step: 'cadastro_pix', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ CRLV Carreta: *${dados.crlvCarreta ? 'Sim' : 'Não'}*\n\n` +
        '💰 Qual sua *chave Pix*?\n_(CPF, telefone, e-mail ou chave aleatória)_'
      );
      break;

    case 'cadastro_pix':
      dados.pix = texto;
      await sessionRef.set({ step: 'cadastro_pis', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ Chave Pix: *${texto}*\n\n` +
        '🔢 Qual o número do seu *PIS*?'
      );
      break;

    case 'cadastro_pis':
      dados.pis = texto;
      await sessionRef.set({ step: 'cadastro_fotos', dadosCadastro: dados, updatedAt: new Date() });
      await enviarTexto(sock, telefone,
        `✅ PIS: *${texto}*\n\n` +
        '📸 Agora envie as *fotos dos documentos*, um por um:\n\n' +
        '1️⃣ Foto da CNH\n' +
        '2️⃣ Foto do CRLV do cavalo\n' +
        '3️⃣ Foto do CRLV da carreta\n' +
        '4️⃣ Foto da ANTT (RNTRC)\n' +
        '5️⃣ Comprovante de residência\n' +
        '6️⃣ Selfie segurando a CNH\n\n' +
        '_As fotos ficam salvas aqui nesta conversa para análise do agenciador._\n\n' +
        'Quando terminar de enviar todas, digite *PRONTO*.'
      );
      break;

    case 'cadastro_fotos':
      if (texto.toUpperCase() === 'PRONTO') {
        // Salva o motorista no Firestore com status pendente
        const motoristaRef = db.collection('frete_motoristas').doc(telefone);
        await motoristaRef.set({
          nome: dados.nome,
          telefone,
          tipoCarreta: dados.tipoCarreta,
          capacidade: dados.capacidade,
          rntrc: dados.rntrc,
          cnhE: dados.cnhE,
          crlvCavalo: dados.crlvCavalo,
          crlvCarreta: dados.crlvCarreta,
          documentos: `Pix: ${dados.pix} | PIS: ${dados.pis}`,
          status: 'pendente-cad',
          disponivel: false,
          regiaoInteresse: null,
          createdAt: new Date(),
        });
        await sessionRef.delete();
        await enviarTexto(sock, telefone,
          '✅ *Cadastro enviado com sucesso!*\n\n' +
          'Seus dados foram recebidos e estão em análise.\n' +
          'Em breve entraremos em contato para confirmar a aprovação.\n\n' +
          '_Assim que aprovado, você começará a receber notificações de cargas disponíveis._'
        );
      } else {
        // Motorista está enviando fotos — só confirma o recebimento
        await enviarTexto(sock, telefone,
          '📎 Documento recebido! Continue enviando os demais.\n' +
          'Quando terminar todos, digite *PRONTO*.'
        );
      }
      break;

    default:
      await iniciarCadastro(sock, telefone, db);
  }
}

// ── HANDLER PRINCIPAL ──────────────────────────────────────────────────────

async function handleFreteMessage(sock, telefoneRaw, textoRaw, db) {
  const telefone = telefoneRaw.replace(/\D/g, '');
  const texto = (textoRaw || '').trim();

  const motoristaRef = db.collection('frete_motoristas').doc(telefone);
  const motoristaSnap = await motoristaRef.get();
  const sessionRef = db.collection('frete_sessions').doc(telefone);
  const sessionSnap = await sessionRef.get();
  const session = sessionSnap.exists ? sessionSnap.data() : null;

  // ── Número não cadastrado: inicia autocadastro ──
  if (!motoristaSnap.exists) {
    // Se já está no meio do cadastro, continua
    if (session && session.step && session.step.startsWith('cadastro_')) {
      await processarCadastro(sock, telefone, texto, session, db);
      return true;
    }
    // Inicia cadastro
    await iniciarCadastro(sock, telefone, db);
    return true;
  }

  const motorista = motoristaSnap.data();

  // ── Cadastro pendente de aprovação ──
  if (motorista.status === 'pendente-cad') {
    await enviarTexto(sock, telefone,
      'Seu cadastro está em análise. Em breve entraremos em contato!'
    );
    return true;
  }

  // ── Motorista aprovado: fluxos normais ──
  if (motorista.status !== 'aprovado') {
    await enviarTexto(sock, telefone,
      'Seu cadastro ainda está em análise. Em breve entraremos em contato.'
    );
    return true;
  }

  // ── 1. Aguardando aceite de carga ──
  if (session && session.step === 'aguardando_aceite' && session.cargaId) {
    if (texto === '1') {
      await processarAceite(sock, db, telefone, motorista, session.cargaId, sessionRef);
      return true;
    }
    if (texto === '2') {
      const cargaDoc = await db.collection('frete_cargas').doc(session.cargaId).get();
      const recusados = (cargaDoc.exists ? cargaDoc.data().recusadoPor : null) || [];
      await db.collection('frete_cargas').doc(session.cargaId).update({
        recusadoPor: [...recusados, telefone],
      });
      await sessionRef.delete();
      await enviarTexto(sock, telefone, 'Tudo bem, carga recusada. Avisaremos na próxima disponível.');
      return true;
    }
    await enviarTexto(sock, telefone, 'Não entendi. Responda:\n1 - Aceitar\n2 - Recusar');
    return true;
  }

  // ── 2. Aguardando escolha de região ──
  if (session && session.step === 'aguardando_regiao') {
    const regiao = REGIOES[texto];
    if (!regiao) {
      await enviarTexto(sock, telefone, 'Opção inválida.\n\n' + menuRegioes());
      return true;
    }
    await motoristaRef.update({ disponivel: true, regiaoInteresse: regiao });
    await sessionRef.delete();
    await enviarTexto(sock, telefone,
      `✅ Pronto! Você está *DISPONÍVEL* para fretes em direção a: *${regiao}*.\n\n` +
      'Avisaremos quando surgir uma carga compatível.'
    );
    return true;
  }

  // ── 3. Aguardando disponibilidade ──
  if (session && session.step === 'aguardando_disponibilidade') {
    if (texto === '1') {
      await sessionRef.set({ step: 'aguardando_regiao', updatedAt: new Date() });
      await enviarTexto(sock, telefone, menuRegioes());
      return true;
    }
    if (texto === '2') {
      await motoristaRef.update({ disponivel: false, regiaoInteresse: null });
      await sessionRef.delete();
      await enviarTexto(sock, telefone,
        'Ok, você está marcado como *INDISPONÍVEL*.\n' +
        'Quando quiser receber cargas, é só mandar uma mensagem aqui.'
      );
      return true;
    }
    await enviarTexto(sock, telefone, 'Não entendi.\n\n' + menuDisponibilidade());
    return true;
  }

  // ── 4. Sem sessão ativa: inicia fluxo de disponibilidade ──
  await sessionRef.set({ step: 'aguardando_disponibilidade', updatedAt: new Date() });
  await enviarTexto(sock, telefone, menuDisponibilidade());
  return true;
}

// ── ACEITE DE CARGA ────────────────────────────────────────────────────────

async function processarAceite(sock, db, telefone, motorista, cargaId, sessionRef) {
  const cargaRef = db.collection('frete_cargas').doc(cargaId);
  let resultado;

  await db.runTransaction(async (tx) => {
    const cargaDoc = await tx.get(cargaRef);
    if (!cargaDoc.exists) { resultado = 'inexistente'; return; }
    const carga = cargaDoc.data();
    if (carga.status !== 'aberta') { resultado = 'ja_atribuida'; return; }
    tx.update(cargaRef, { status: 'aceita', motoristaId: telefone, motoristaNome: motorista.nome });
    resultado = 'ok';
  });

  await sessionRef.delete();

  if (resultado === 'inexistente') {
    await enviarTexto(sock, telefone, 'Essa carga não está mais disponível.');
    return;
  }
  if (resultado === 'ja_atribuida') {
    await enviarTexto(sock, telefone,
      'Essa carga já foi atribuída a outro motorista. Fique atento às próximas!'
    );
    return;
  }

  const pixSnap = await db.collection('frete_config').doc('geral').get();
  const pixKey = pixSnap.exists ? pixSnap.data().pixKey : '(configure a chave Pix no painel)';
  const cargaDoc = await cargaRef.get();
  const carga = cargaDoc.data();

  await enviarTexto(sock, telefone,
    `✅ *Carga confirmada!*\n\n` +
    `Transportadora: ${carga.transportadora}\n` +
    `Origem: ${carga.origem}\nDestino: ${carga.destino}\n\n` +
    `💰 Taxa de agenciamento: *R$ ${carga.taxa}*\n` +
    `🔑 Chave Pix: *${pixKey}*\n\n` +
    (carga.mensagemCompleta ? `📋 *Detalhes completos da carga:*\n\n${carga.mensagemCompleta}\n\n` : ``) +
    (carga.linkReferencia ? `🔗 *Link da carga:*\n${carga.linkReferencia}\n\n` : ``) +
    `Por favor, envie o comprovante de pagamento da taxa aqui neste WhatsApp.`
  );

  // Avisa outros motoristas que a carga já foi
  const outros = (carga.offeredTo || []).filter(id => id !== telefone);
  for (const idOutro of outros) {
    const outraSessionRef = db.collection('frete_sessions').doc(idOutro);
    const outraSessao = await outraSessionRef.get();
    if (outraSessao.exists && outraSessao.data().cargaId === cargaId) {
      await outraSessionRef.delete();
      await enviarTexto(sock, idOutro,
        'Essa carga já foi atribuída a outro motorista. Obrigado por responder — fique atento às próximas!'
      );
    }
  }
}

// ── MONITOR DE DISPAROS ────────────────────────────────────────────────────

function watchDisparos(sock, db) {
  db.collection('frete_disparos')
    .where('processado', '==', false)
    .onSnapshot(async (snap) => {
      for (const change of snap.docChanges()) {
        if (change.type !== 'added') continue;
        await processarDisparo(sock, db, change.doc.id, change.doc.data());
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
    `📦 *Carga disponível!*\n\n` +
    `Transportadora: ${carga.transportadora}\n` +
    `Origem: ${carga.origem}\n` +
    `Destino: ${carga.destino}\n` +
    `Tipo de carga: ${carga.tipoCarga}\n` +
    `Peso/Volume: ${carga.peso || '-'}\n` +
    `Carreta exigida: ${carga.tipoCarretaExigida}\n` +
    `Data de coleta: ${carga.dataColeta}\n` +
    `💰 Taxa: *R$ ${carga.taxa}*\n\n` +
    `1 - ✅ Aceitar\n2 - ❌ Recusar`;

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

module.exports = { handleFreteMessage, watchDisparos };
