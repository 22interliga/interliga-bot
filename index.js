// ============================================================
// INTERLIGA — BOT WHATSAPP
// Tecnologias: Evolution API + Firebase + Node.js
// Versão: 1.0.0
// ============================================================

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// ============================================================
// ⚙️ CONFIGURAÇÃO — edite apenas este bloco
// ============================================================
const CONFIG = {
  // Evolution API
  EVOLUTION_URL: process.env.EVOLUTION_URL || 'http://localhost:8080',
  EVOLUTION_KEY: process.env.EVOLUTION_KEY || 'sua-api-key',
  INSTANCE:      process.env.EVOLUTION_INSTANCE || 'interliga',

  // Firebase
  FIREBASE_CRED: process.env.FIREBASE_CREDENTIALS || './firebase-credentials.json',

  // App URL (link de rastreio enviado ao cliente)
  APP_URL: process.env.APP_URL || 'https://interliga-app.netlify.app',

  // Precificação base (pode sobrescrever pelo painel admin)
  TARIFA_BASE_KM:   2.40,
  BANDEIRADA:       5.00,
  MINIMO:           8.00,
  ESPERA_POR_MIN:   0.30,

  // Tempo limite para motorista aceitar (segundos)
  TIMEOUT_ACEITE: 30,

  // Porta do servidor
  PORT: process.env.PORT || 3000,
};

// ============================================================
// 🔥 FIREBASE INIT
// ============================================================
let db;
try {
  // Tenta carregar credenciais via variável de ambiente (Railway)
  // ou via arquivo local (desenvolvimento)
  let credential;
  if (process.env.FIREBASE_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_JSON);
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_CREDENTIALS) {
    const serviceAccount = require(process.env.FIREBASE_CREDENTIALS);
    credential = admin.credential.cert(serviceAccount);
  } else {
    throw new Error('Sem credenciais Firebase — modo demo ativo');
  }
  admin.initializeApp({ credential });
  db = admin.firestore();
  console.log('✅ Firebase conectado');
} catch (e) {
  console.warn('⚠️ Firebase não configurado — modo demo ativo');
  db = null;
}

// ============================================================
// 💬 ENVIAR MENSAGEM WHATSAPP
// ============================================================
async function sendMsg(phone, text) {
  try {
    await axios.post(
      `${CONFIG.EVOLUTION_URL}/message/sendText/${CONFIG.INSTANCE}`,
      { number: phone, textMessage: { text } },
      { headers: { apikey: CONFIG.EVOLUTION_KEY } }
    );
  } catch (e) {
    console.error('Erro ao enviar mensagem:', e.message);
  }
}

async function sendList(phone, title, text, options) {
  const numbered = options.map((opt, i) => `*${i+1}* — ${opt}`).join('\n');
  await sendMsg(phone, `${title}\n\n${text}\n\n${numbered}`);
}

// ============================================================
// 🗺️ GEOLOCALIZAÇÃO E CÁLCULO DE ROTA
// ============================================================
async function geocode(address, city) {
  try {
    const query = encodeURIComponent(`${address}, ${city}, Brasil`);
    const res = await axios.get(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { headers: { 'User-Agent': 'InterligaBot/1.0' } }
    );
    if (res.data.length > 0) {
      return {
        lat: parseFloat(res.data[0].lat),
        lon: parseFloat(res.data[0].lon),
        display: res.data[0].display_name,
      };
    }
    return null;
  } catch (e) {
    console.error('Erro geocode:', e.message);
    return null;
  }
}

async function calcRoute(originLat, originLon, destLat, destLon) {
  try {
    const res = await axios.get(
      `http://router.project-osrm.org/route/v1/driving/${originLon},${originLat};${destLon},${destLat}?overview=false`,
      { timeout: 5000 }
    );
    if (res.data.routes && res.data.routes.length > 0) {
      const route = res.data.routes[0];
      return {
        distanciaKm: (route.distance / 1000).toFixed(1),
        duracaoMin: Math.ceil(route.duration / 60),
      };
    }
    return null;
  } catch (e) {
    // Fallback: calcular distância em linha reta
    const R = 6371;
    const dLat = (destLat - originLat) * Math.PI / 180;
    const dLon = (destLon - originLon) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(originLat*Math.PI/180) *
              Math.cos(destLat*Math.PI/180) * Math.sin(dLon/2)**2;
    const distancia = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return {
      distanciaKm: distancia.toFixed(1),
      duracaoMin: Math.ceil(distancia * 3),
    };
  }
}

function calcTarifa(distanciaKm, categoria = 'x') {
  const multiplicadores = { x: 1.0, plus: 1.4, van: 2.0 };
  const mult = multiplicadores[categoria] || 1.0;
  const valor = Math.max(
    CONFIG.MINIMO,
    CONFIG.BANDEIRADA + parseFloat(distanciaKm) * CONFIG.TARIFA_BASE_KM
  ) * mult;
  return valor.toFixed(2);
}

// ============================================================
// 💾 SESSÕES DOS CLIENTES (em memória + Firebase)
// ============================================================
const sessions = new Map();

async function getSession(phone) {
  if (sessions.has(phone)) return sessions.get(phone);
  // Tentar carregar do Firebase
  if (db) {
    try {
      const doc = await db.collection('whatsapp_sessions').doc(phone).get();
      if (doc.exists) {
        const data = doc.data();
        sessions.set(phone, data);
        return data;
      }
    } catch (e) {}
  }
  return null;
}

async function setSession(phone, data) {
  sessions.set(phone, data);
  if (db) {
    try {
      await db.collection('whatsapp_sessions').doc(phone).set(data, { merge: true });
    } catch (e) {}
  }
}

async function clearSession(phone) {
  sessions.delete(phone);
  if (db) {
    try {
      await db.collection('whatsapp_sessions').doc(phone).delete();
    } catch (e) {}
  }
}

// ============================================================
// 🚗 BUSCAR MOTORISTA DISPONÍVEL
// ============================================================
async function buscarMotorista(corridaId, origemLat, origemLon) {
  if (!db) {
    // Modo demo — simular motorista encontrado após 3s
    return new Promise(resolve => {
      setTimeout(() => resolve({
        id: 'DEMO001',
        nome: 'Marcos R.',
        veiculo: 'Honda Civic',
        placa: 'ABC-1234',
        avaliacao: '4.93',
        fcmToken: null,
      }), 3000);
    });
  }

  try {
    const motoristas = await db.collection('motoristas')
      .where('online', '==', true)
      .where('bloqueado', '==', false)
      .where('emCorrida', '==', false)
      .limit(10)
      .get();

    if (motoristas.empty) return null;

    // Notificar todos os motoristas disponíveis
    const notificacoes = motoristas.docs.map(async doc => {
      const m = doc.data();
      if (m.fcmToken) {
        await admin.messaging().send({
          token: m.fcmToken,
          notification: {
            title: '🚗 Nova corrida disponível!',
            body: `Corrida #${corridaId} — Aceite em ${CONFIG.TIMEOUT_ACEITE}s`,
          },
          data: { tipo: 'nova_corrida', corridaId },
          android: { priority: 'high' },
        }).catch(() => {});
      }
    });
    await Promise.all(notificacoes);

    // Aguardar aceitação (polling por TIMEOUT_ACEITE segundos)
    const inicio = Date.now();
    while (Date.now() - inicio < CONFIG.TIMEOUT_ACEITE * 1000) {
      await new Promise(r => setTimeout(r, 2000));
      const corrida = await db.collection('corridas').doc(corridaId).get();
      if (corrida.data()?.status === 'aceita') {
        const motId = corrida.data().motoristaId;
        const mot = await db.collection('motoristas').doc(motId).get();
        return mot.data();
      }
    }
    return null;
  } catch (e) {
    console.error('Erro ao buscar motorista:', e.message);
    return null;
  }
}

// ============================================================
// 📝 SALVAR CORRIDA NO FIREBASE
// ============================================================
async function salvarCorrida(dados) {
  const id = 'C' + Date.now();
  if (db) {
    try {
      await db.collection('corridas').doc(id).set({
        ...dados,
        id,
        status: 'aguardando',
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.error('Erro ao salvar corrida:', e.message);
    }
  }
  return id;
}

// ============================================================
// 🤖 PROCESSAMENTO DE MENSAGENS
// ============================================================
async function processMessage(phone, message, name) {
  const text = message.trim().toLowerCase();
  const session = await getSession(phone);

  // ── COMANDOS GLOBAIS ──
  if (['oi', 'olá', 'ola', 'menu', 'inicio', 'início', '0'].includes(text)) {
    await clearSession(phone);
    await sendMsg(phone,
      `👋 Olá, *${name || 'cliente'}*! Bem-vindo à *INTERLIGA* 🚗\n\n` +
      `O que deseja fazer?\n\n` +
      `*1* — 🚗 Solicitar corrida\n` +
      `*2* — 📅 Agendar corrida\n` +
      `*3* — 📋 Minhas corridas\n` +
      `*4* — ⭐ Avaliações\n` +
      `*5* — 💳 Formas de pagamento\n` +
      `*6* — 🆘 Suporte\n\n` +
      `_Digite o número da opção desejada_`
    );
    await setSession(phone, { estado: 'MENU' });
    return;
  }

  if (['cancelar', 'cancel', 'sair'].includes(text)) {
    await clearSession(phone);
    await sendMsg(phone, '❌ Operação cancelada.\n\nDigite *oi* para voltar ao menu.');
    return;
  }

  // ── SEM SESSÃO ── inicia fluxo
  if (!session) {
    await processMessage(phone, 'oi', name);
    return;
  }

  // ── MENU PRINCIPAL ──
  if (session.estado === 'MENU') {
    if (text === '1' || text.includes('corrida')) {
      await setSession(phone, { estado: 'AGUARDANDO_EMBARQUE' });
      await sendMsg(phone,
        `🚩 *ONDE O MOTORISTA IRÁ BUSCAR VOCÊ?*\n\n` +
        `Por favor, informe o endereço com número.\n\n` +
        `*Exemplo:*\n` +
        `_Rua das Flores, 240_\n` +
        `_Avenida Brasil, 1500_\n\n` +
        `Ou informe um *ponto de referência*:\n` +
        `_Em frente ao mercado do João_\n\n` +
        `_Digite *cancelar* para voltar ao menu_`
      );
    } else if (text === '2') {
      await setSession(phone, { estado: 'AGUARDANDO_DATA_AGENDAMENTO' });
      await sendMsg(phone,
        `📅 *AGENDAR CORRIDA*\n\n` +
        `Para qual data e horário?\n\n` +
        `*Exemplo:*\n` +
        `_Amanhã às 08:00_\n` +
        `_15/06 às 14:30_\n` +
        `_Sexta-feira às 07:00_`
      );
    } else if (text === '3') {
      await sendHistorico(phone);
    } else if (text === '6') {
      await sendMsg(phone,
        `🆘 *SUPORTE INTERLIGA*\n\n` +
        `📧 suporte@interliga.com.br\n` +
        `📞 (XX) XXXXX-XXXX\n\n` +
        `Nosso time responde em até 30 minutos!\n\n` +
        `_Digite *oi* para voltar ao menu_`
      );
    } else {
      await sendMsg(phone, '❓ Opção inválida. Digite o número da opção:\n\n*1* Corrida · *2* Agendar · *3* Histórico · *6* Suporte');
    }
    return;
  }

  // ── AGUARDANDO ENDEREÇO DE EMBARQUE ──
  if (session.estado === 'AGUARDANDO_EMBARQUE') {
    await setSession(phone, { ...session, embarqueRaw: message, estado: 'AGUARDANDO_CIDADE_EMBARQUE' });
    await sendMsg(phone,
      `📍 Endereço informado: *${message}*\n\n` +
      `🏙️ Qual a *cidade* desse endereço?\n\n` +
      `*Exemplo:* Mãe de Deus, Maraú, Itacaré...`
    );
    return;
  }

  // ── AGUARDANDO CIDADE DO EMBARQUE ──
  if (session.estado === 'AGUARDANDO_CIDADE_EMBARQUE') {
    await sendMsg(phone, `🔍 Localizando endereço de embarque...`);
    const geo = await geocode(session.embarqueRaw, message);
    if (!geo) {
      await sendMsg(phone,
        `⚠️ Não consegui localizar *"${session.embarqueRaw}"* em *${message}*.\n\n` +
        `Tente ser mais específico:\n` +
        `_Ex: Rua das Flores, 240, Centro_\n\n` +
        `Ou informe um ponto de referência conhecido.`
      );
      return;
    }
    const enderecoFormatado = geo.display.split(',').slice(0,3).join(',');
    await setSession(phone, {
      ...session,
      cidadeEmbarque: message,
      embarqueGeo: { lat: geo.lat, lon: geo.lon },
      embarqueFormatado: enderecoFormatado,
      estado: 'AGUARDANDO_DESTINO',
    });
    await sendMsg(phone,
      `✅ Local de embarque encontrado:\n*${enderecoFormatado}*\n\n` +
      `🎯 *ONDE O MOTORISTA IRÁ TE DEIXAR?*\n\n` +
      `Informe o endereço de destino:\n\n` +
      `*Exemplo:*\n` +
      `_Rua Floriano Peixoto, 233_\n` +
      `_Hospital Municipal_\n` +
      `_Shopping Center_`
    );
    return;
  }

  // ── AGUARDANDO DESTINO ──
  if (session.estado === 'AGUARDANDO_DESTINO') {
    await setSession(phone, { ...session, destinoRaw: message, estado: 'AGUARDANDO_CIDADE_DESTINO' });
    await sendMsg(phone,
      `📍 Destino informado: *${message}*\n\n` +
      `🏙️ Qual a *cidade* do destino?\n\n` +
      `_(Pode ser a mesma cidade de embarque)_`
    );
    return;
  }

  // ── AGUARDANDO CIDADE DO DESTINO ──
  if (session.estado === 'AGUARDANDO_CIDADE_DESTINO') {
    await sendMsg(phone, `🔍 Calculando rota...`);
    const geo = await geocode(session.destinoRaw, message);
    if (!geo) {
      await sendMsg(phone,
        `⚠️ Não consegui localizar *"${session.destinoRaw}"* em *${message}*.\n\n` +
        `Tente ser mais específico.`
      );
      return;
    }

    const rota = await calcRoute(
      session.embarqueGeo.lat, session.embarqueGeo.lon,
      geo.lat, geo.lon
    );

    const destinoFormatado = geo.display.split(',').slice(0,3).join(',');
    const distancia = rota?.distanciaKm || '?';
    const duracao = rota?.duracaoMin || '?';

    // Calcular tarifas para cada categoria
    const valorX    = calcTarifa(distancia, 'x');
    const valorPlus = calcTarifa(distancia, 'plus');
    const valorVan  = calcTarifa(distancia, 'van');

    await setSession(phone, {
      ...session,
      cidadeDestino: message,
      destinoGeo: { lat: geo.lat, lon: geo.lon },
      destinoFormatado,
      distanciaKm: distancia,
      duracaoMin: duracao,
      valorX, valorPlus, valorVan,
      estado: 'AGUARDANDO_CATEGORIA',
    });

    await sendMsg(phone,
      `✅ Rota calculada!\n\n` +
      `🚩 *Embarque:*\n${session.embarqueFormatado}\n\n` +
      `🏁 *Destino:*\n${destinoFormatado}\n\n` +
      `📏 *Distância:* ${distancia} km\n` +
      `⏱️ *Tempo estimado:* ${duracao} min\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🚗 Escolha o tipo de veículo:\n\n` +
      `*1* — 🚗 Interliga X · R$ ${valorX}\n` +
      `      _(Sedan/Hatch · até 4 pessoas)_\n\n` +
      `*2* — 🚙 Interliga Plus · R$ ${valorPlus}\n` +
      `      _(SUV espaçoso · até 4 pessoas)_\n\n` +
      `*3* — 🚐 Interliga Van · R$ ${valorVan}\n` +
      `      _(Van · até 8 pessoas)_\n\n` +
      `_Digite *cancelar* para voltar ao menu_`
    );
    return;
  }

  // ── AGUARDANDO CATEGORIA ──
  if (session.estado === 'AGUARDANDO_CATEGORIA') {
    const cats = { '1': { nome: 'Interliga X', emoji: '🚗', valor: session.valorX },
                   '2': { nome: 'Interliga Plus', emoji: '🚙', valor: session.valorPlus },
                   '3': { nome: 'Interliga Van', emoji: '🚐', valor: session.valorVan } };
    const cat = cats[text];
    if (!cat) {
      await sendMsg(phone, '❓ Digite *1*, *2* ou *3* para escolher o veículo.');
      return;
    }
    await setSession(phone, { ...session, categoria: cat, estado: 'AGUARDANDO_PAGAMENTO' });
    await sendMsg(phone,
      `${cat.emoji} *${cat.nome}* selecionado!\n\n` +
      `💰 *Valor da corrida: R$ ${cat.valor}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💳 *Forma de pagamento:*\n\n` +
      `*1* — 💚 Pix _(instantâneo)_\n` +
      `*2* — 💳 Cartão de crédito\n` +
      `*3* — 💵 Dinheiro ao motorista\n` +
      `*4* — 👛 Carteira Interliga`
    );
    return;
  }

  // ── AGUARDANDO FORMA DE PAGAMENTO ──
  if (session.estado === 'AGUARDANDO_PAGAMENTO') {
    const pagamentos = {
      '1': 'Pix 💚', '2': 'Cartão 💳',
      '3': 'Dinheiro 💵', '4': 'Carteira Interliga 👛'
    };
    const pag = pagamentos[text];
    if (!pag) {
      await sendMsg(phone, '❓ Digite *1*, *2*, *3* ou *4* para a forma de pagamento.');
      return;
    }
    await setSession(phone, { ...session, pagamento: pag, estado: 'CONFIRMANDO_CORRIDA' });
    await sendMsg(phone,
      `✅ *RESUMO DA CORRIDA*\n\n` +
      `🚩 *Embarque:*\n${session.embarqueFormatado}\n\n` +
      `🏁 *Destino:*\n${session.destinoFormatado}\n\n` +
      `📏 Distância: *${session.distanciaKm} km*\n` +
      `⏱️ Tempo est.: *${session.duracaoMin} min*\n` +
      `${session.categoria.emoji} Veículo: *${session.categoria.nome}*\n` +
      `💰 Valor: *R$ ${session.categoria.valor}*\n` +
      `💳 Pagamento: *${pag}*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*1* — ✅ Confirmar corrida\n` +
      `*2* — ❌ Cancelar`
    );
    return;
  }

  // ── CONFIRMANDO CORRIDA ──
  if (session.estado === 'CONFIRMANDO_CORRIDA') {
    if (text === '2' || text.includes('cancelar') || text.includes('não')) {
      await clearSession(phone);
      await sendMsg(phone, '❌ Corrida cancelada.\n\nDigite *oi* para solicitar uma nova corrida.');
      return;
    }
    if (text === '1' || text.includes('confirmar') || text.includes('sim') || text.includes('pode')) {

      // Salvar corrida
      const corridaId = await salvarCorrida({
        clientePhone: phone,
        clienteNome: name,
        embarque: session.embarqueFormatado,
        embarqueGeo: session.embarqueGeo,
        destino: session.destinoFormatado,
        destinoGeo: session.destinoGeo,
        distanciaKm: session.distanciaKm,
        duracaoMin: session.duracaoMin,
        categoria: session.categoria.nome,
        valor: session.categoria.valor,
        pagamento: session.pagamento,
      });

      await setSession(phone, { ...session, corridaId, estado: 'BUSCANDO_MOTORISTA' });
      await sendMsg(phone,
        `🔍 *Procurando motoristas disponíveis...*\n\n` +
        `Corrida *#${corridaId}*\n` +
        `Por favor, aguarde. Notificaremos em instantes! 🚗`
      );

      // Buscar motorista em background
      buscarMotorista(corridaId, session.embarqueGeo.lat, session.embarqueGeo.lon)
        .then(async (motorista) => {
          if (!motorista) {
            await clearSession(phone);
            await sendMsg(phone,
              `😔 *Não encontramos motoristas disponíveis* no momento.\n\n` +
              `👉 Digite *1* para tentar novamente\n` +
              `👉 Digite *oi* para voltar ao menu`
            );
            await setSession(phone, { estado: 'MENU' });
            return;
          }

          const trackLink = `${CONFIG.APP_URL}?corrida=${corridaId}`;
          await setSession(phone, {
            ...session, corridaId,
            motorista,
            estado: 'CORRIDA_ACEITA'
          });

          await sendMsg(phone,
            `🎉 *MOTORISTA ENCONTRADO!*\n\n` +
            `👨‍💼 *${motorista.nome}*\n` +
            `🚗 ${motorista.veiculo} · ${motorista.placa}\n` +
            `⭐ Avaliação: ${motorista.avaliacao}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📍 *Acompanhe em tempo real:*\n` +
            `${trackLink}\n\n` +
            `_(Abra o link para ver o motorista no mapa)_\n\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `💬 *Precisa falar com o motorista?*\n` +
            `Digite sua mensagem aqui que repasso! 📲\n\n` +
            `*C* — ❌ Cancelar corrida`
          );
        });
      return;
    }
    await sendMsg(phone, 'Digite *1* para confirmar ou *2* para cancelar.');
    return;
  }

  // ── CORRIDA ACEITA — chat com motorista ──
  if (session.estado === 'CORRIDA_ACEITA') {
    if (text === 'c' || text.includes('cancelar')) {
      await clearSession(phone);
      await sendMsg(phone,
        `❌ *Corrida cancelada.*\n\n` +
        `⚠️ Atenção: cancelamentos frequentes podem gerar taxa.\n\n` +
        `Digite *oi* para solicitar nova corrida.`
      );
      return;
    }
    // Repassar mensagem ao motorista (via Firebase)
    if (db && session.corridaId) {
      try {
        await db.collection('chats').add({
          corridaId: session.corridaId,
          de: 'cliente',
          para: 'motorista',
          mensagem: message,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {}
    }
    await sendMsg(phone, `✅ Mensagem enviada ao motorista:\n_"${message}"_\n\nAguarde a resposta.`);
    return;
  }

  // ── AGENDAMENTO ──
  if (session.estado === 'AGUARDANDO_DATA_AGENDAMENTO') {
    await setSession(phone, { ...session, dataAgendamento: message, estado: 'AGUARDANDO_EMBARQUE' });
    await sendMsg(phone,
      `📅 Agendado para: *${message}*\n\n` +
      `🚩 *ONDE O MOTORISTA IRÁ BUSCAR VOCÊ?*\n\n` +
      `Informe o endereço de embarque:`
    );
    return;
  }

  // ── FALLBACK ──
  await sendMsg(phone,
    `🤖 Não entendi. Tente:\n\n` +
    `• *oi* — Menu principal\n` +
    `• *1* — Solicitar corrida\n` +
    `• *cancelar* — Cancelar operação atual`
  );
}

// ============================================================
// 📊 HISTÓRICO DO CLIENTE
// ============================================================
async function sendHistorico(phone) {
  if (!db) {
    await sendMsg(phone, '📋 *Suas últimas corridas:*\n\n_Nenhuma corrida encontrada._\n\nDigite *1* para solicitar sua primeira corrida!');
    return;
  }
  try {
    const corridas = await db.collection('corridas')
      .where('clientePhone', '==', phone)
      .orderBy('criadoEm', 'desc')
      .limit(5)
      .get();

    if (corridas.empty) {
      await sendMsg(phone, '📋 Você ainda não tem corridas.\n\nDigite *1* para solicitar!');
      return;
    }

    let texto = '📋 *Suas últimas corridas:*\n\n';
    corridas.docs.forEach((doc, i) => {
      const c = doc.data();
      texto += `*${i+1}.* ${c.categoria} · R$ ${c.valor}\n`;
      texto += `   ${c.embarque} → ${c.destino}\n\n`;
    });
    await sendMsg(phone, texto);
  } catch (e) {
    await sendMsg(phone, '⚠️ Erro ao carregar histórico. Tente novamente.');
  }
}

// ============================================================
// 🌐 WEBHOOK — recebe mensagens da Evolution API
// ============================================================
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Verificar se é mensagem válida
    if (!body?.data?.key?.remoteJid || !body?.data?.message) {
      return res.sendStatus(200);
    }

    const phone = body.data.key.remoteJid.replace('@s.whatsapp.net', '');
    const name  = body.data.pushName || 'Cliente';
    const msg   = body.data.message;

    // Extrair texto da mensagem
    let text = '';
    if (msg.conversation)                          text = msg.conversation;
    else if (msg.extendedTextMessage?.text)        text = msg.extendedTextMessage.text;
    else if (msg.buttonsResponseMessage?.selectedButtonId) text = msg.buttonsResponseMessage.selectedButtonId;
    else if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) text = msg.listResponseMessage.singleSelectReply.selectedRowId;

    if (!text || body.data.key.fromMe) return res.sendStatus(200);

    console.log(`📨 [${phone}] ${name}: ${text}`);
    await processMessage(phone, text, name);
    res.sendStatus(200);
  } catch (e) {
    console.error('Erro no webhook:', e);
    res.sendStatus(500);
  }
});


// ============================================================
// 📱 ENDPOINT — APP INTERLIGA (chamado pelo PWA)
// ============================================================

// Recebe solicitação de corrida vinda do app
app.post('/nova-corrida', async (req, res) => {
  try {
    const { origem, destino, valor, telefone, nome } = req.body;
    if (!origem || !destino) {
      return res.status(400).json({ erro: 'origem e destino obrigatórios' });
    }

    // Gerar ID da corrida
    const corridaId = 'APP' + Date.now();

    // Salvar no Firebase
    if (db) {
      await db.collection('corridas').doc(corridaId).set({
        id: corridaId,
        clientePhone: telefone || 'app-user',
        clienteNome: nome || 'Passageiro App',
        embarque: origem,
        destino,
        valor: valor || '0',
        origem: 'app',
        status: 'aguardando',
        criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Buscar motorista
    const motorista = await buscarMotorista(corridaId, null, null);

    if (!motorista) {
      return res.json({ sucesso: false, mensagem: 'Nenhum motorista disponível no momento' });
    }

    return res.json({
      sucesso: true,
      corridaId,
      motorista: {
        nome: motorista.nome,
        veiculo: motorista.veiculo,
        placa: motorista.placa,
        avaliacao: motorista.avaliacao,
      },
      mensagem: 'Motorista encontrado!',
    });
  } catch (e) {
    console.error('Erro /nova-corrida:', e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Recebe mensagem do chat do app e repassa ao motorista
app.post('/chat', async (req, res) => {
  try {
    const { corridaId, mensagem, de } = req.body;
    if (!corridaId || !mensagem) {
      return res.status(400).json({ erro: 'corridaId e mensagem obrigatórios' });
    }

    if (db) {
      await db.collection('chats').add({
        corridaId,
        de: de || 'passageiro',
        mensagem,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json({ sucesso: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Busca mensagens do chat (polling)
app.get('/chat/:corridaId', async (req, res) => {
  try {
    const { corridaId } = req.params;
    if (!db) return res.json({ mensagens: [] });

    const msgs = await db.collection('chats')
      .where('corridaId', '==', corridaId)
      .orderBy('timestamp', 'asc')
      .limit(50)
      .get();

    const mensagens = msgs.docs.map(d => ({
      de: d.data().de,
      mensagem: d.data().mensagem,
      timestamp: d.data().timestamp?.toDate?.() || new Date(),
    }));

    res.json({ mensagens });
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Status de uma corrida
app.get('/corrida/:corridaId', async (req, res) => {
  try {
    const { corridaId } = req.params;
    if (!db) return res.json({ status: 'aguardando' });

    const doc = await db.collection('corridas').doc(corridaId).get();
    if (!doc.exists) return res.status(404).json({ erro: 'Corrida não encontrada' });

    res.json(doc.data());
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// ============================================================
// 🏥 HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'Interliga WhatsApp Bot',
    version: '1.0.0',
    firebase: db ? 'connected' : 'demo-mode',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ============================================================
// 🚀 INICIAR SERVIDOR
// ============================================================
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 Interliga Bot rodando na porta ${CONFIG.PORT}`);
  console.log(`📡 Webhook: http://localhost:${CONFIG.PORT}/webhook`);
  console.log(`🔥 Firebase: ${db ? 'conectado' : 'modo demo'}\n`);
});

module.exports = app;
