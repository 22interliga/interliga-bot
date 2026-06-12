// Fix: crypto necessário para o Baileys
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeBase64 = null;
let botStatus = 'iniciando';
let lastError = '';

// ============================================================
// SESSÕES DE CONVERSA
// ============================================================
const sessions = new Map();
function getSession(phone) { return sessions.get(phone) || null; }
function setSession(phone, data) { sessions.set(phone, data); }
function clearSession(phone) { sessions.delete(phone); }

// ============================================================
// CÁLCULO DE TARIFAS
// ============================================================
const CONFIG = {
  BANDEIRADA: 5.00,
  TARIFA_KM: 2.40,
  MINIMO: 8.00,
  APP_URL: 'https://22interliga.github.io/interliga/',
};

function calcTarifa(distKm, cat = 'x') {
  const mult = { x: 1.0, plus: 1.4, van: 2.0 }[cat] || 1.0;
  return Math.max(CONFIG.MINIMO, (CONFIG.BANDEIRADA + parseFloat(distKm) * CONFIG.TARIFA_KM) * mult);
}

async function geocode(address) {
  try {
    const q = encodeURIComponent(address + ', Bahia, Brasil');
    const r = await axios.get(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { 'User-Agent': 'InterligaBot/2.0' }, timeout: 6000
    });
    if (r.data.length > 0) return { lat: parseFloat(r.data[0].lat), lon: parseFloat(r.data[0].lon), nome: r.data[0].display_name.split(',').slice(0, 3).join(',') };
    return null;
  } catch { return null; }
}

async function calcRota(oLat, oLon, dLat, dLon) {
  try {
    const r = await axios.get(`http://router.project-osrm.org/route/v1/driving/${oLon},${oLat};${dLon},${dLat}?overview=false`, { timeout: 6000 });
    if (r.data.routes?.length > 0) return { km: (r.data.routes[0].distance / 1000).toFixed(1), min: Math.ceil(r.data.routes[0].duration / 60) };
  } catch {}
  // Fallback linha reta
  const R = 6371, dLat2 = (dLat - oLat) * Math.PI / 180, dLon2 = (dLon - oLon) * Math.PI / 180;
  const a = Math.sin(dLat2/2)**2 + Math.cos(oLat*Math.PI/180)*Math.cos(dLat*Math.PI/180)*Math.sin(dLon2/2)**2;
  const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return { km: d.toFixed(1), min: Math.ceil(d * 3) };
}

async function buscarMotorista() {
  await new Promise(r => setTimeout(r, 3000));
  return { nome: 'Marcos R.', veiculo: 'Honda Civic', placa: 'ABC-1234', avaliacao: '4.93' };
}

// ============================================================
// PROCESSAMENTO DE MENSAGENS
// ============================================================
async function processMessage(jid, text, name) {
  const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
  const txt = text.trim().toLowerCase();
  const session = getSession(phone);

  const send = async (msg) => {
    try { await sock.sendMessage(jid, { text: msg }); } catch(e) { console.error('Erro ao enviar:', e.message); }
  };

  // Comandos globais
  if (['oi', 'olá', 'ola', 'menu', 'inicio', '0', 'voltar'].includes(txt)) {
    clearSession(phone);
    await send(
      `👋 Olá, *${name}*! Bem-vindo à *INTERLIGA* 🚗\n\n` +
      `O que deseja fazer?\n\n` +
      `*1* — 🚗 Solicitar corrida\n` +
      `*2* — 📅 Agendar corrida\n` +
      `*3* — 📋 Minhas corridas\n` +
      `*6* — 🆘 Suporte\n\n` +
      `_Digite o número da opção_`
    );
    setSession(phone, { estado: 'MENU' });
    return;
  }

  if (['cancelar', 'cancel', 'sair'].includes(txt)) {
    clearSession(phone);
    await send('❌ Operação cancelada.\n\nDigite *oi* para voltar ao menu.');
    return;
  }

  if (!session) { await processMessage(jid, 'oi', name); return; }

  // ── MENU ──
  if (session.estado === 'MENU') {
    if (txt === '1') {
      setSession(phone, { estado: 'EMBARQUE' });
      await send(`🚩 *PONTO DE EMBARQUE*\n\nDigite o endereço onde o motorista irá te buscar:\n\n_Ex: Rua das Flores, 240, Madre de Deus_\n\n_Digite *cancelar* para voltar_`);
    } else if (txt === '2') {
      setSession(phone, { estado: 'AGENDAR_DATA' });
      await send(`📅 *AGENDAR CORRIDA*\n\nPara qual data e horário?\n\n_Ex: Amanhã às 08:00 ou 15/06 às 14:30_`);
    } else if (txt === '3') {
      await send(`📋 *Suas últimas corridas:*\n\n_Nenhuma corrida encontrada._\n\nDigite *1* para solicitar uma corrida!`);
    } else if (txt === '6') {
      await send(`🆘 *SUPORTE INTERLIGA*\n\n📞 (71) 98189-9571\n🌐 ${CONFIG.APP_URL}\n\nNosso time responde em até 30 minutos!\n\n_Digite *oi* para voltar ao menu_`);
    } else {
      await send(`❓ Digite o número da opção:\n\n*1* Corrida · *2* Agendar · *3* Histórico · *6* Suporte`);
    }
    return;
  }

  // ── EMBARQUE ──
  if (session.estado === 'EMBARQUE') {
    await send(`🔍 Localizando *${text}*...`);
    const geo = await geocode(text);
    if (!geo) {
      await send(`⚠️ Não encontrei o endereço *"${text}"*.\n\nTente ser mais específico, incluindo cidade.\n\n_Ex: Rua das Flores, 240, Madre de Deus_`);
      return;
    }
    setSession(phone, { ...session, embarque: text, embarqueNome: geo.nome, embarqueGeo: { lat: geo.lat, lon: geo.lon }, estado: 'DESTINO' });
    await send(`✅ *${geo.nome}*\n\n🎯 *DESTINO*\n\nAgora informe o endereço de destino:`);
    return;
  }

  // ── DESTINO ──
  if (session.estado === 'DESTINO') {
    await send(`🔍 Calculando rota...`);
    const geo = await geocode(text);
    if (!geo) {
      await send(`⚠️ Não encontrei o destino *"${text}"*.\n\nTente ser mais específico.`);
      return;
    }
    const rota = await calcRota(session.embarqueGeo.lat, session.embarqueGeo.lon, geo.lat, geo.lon);
    const vX = calcTarifa(rota.km, 'x').toFixed(2);
    const vPlus = calcTarifa(rota.km, 'plus').toFixed(2);
    const vVan = calcTarifa(rota.km, 'van').toFixed(2);
    setSession(phone, { ...session, destino: text, destinoNome: geo.nome, destinoGeo: { lat: geo.lat, lon: geo.lon }, km: rota.km, min: rota.min, vX, vPlus, vVan, estado: 'CATEGORIA' });
    await send(
      `✅ Rota calculada!\n\n` +
      `🚩 *Embarque:* ${session.embarqueNome}\n` +
      `🏁 *Destino:* ${geo.nome}\n` +
      `📏 *Distância:* ${rota.km} km · ⏱️ *${rota.min} min*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🚗 *Escolha a categoria:*\n\n` +
      `*1* — 🚗 Interliga X · R$ ${vX} _(até 4 pessoas)_\n` +
      `*2* — 🚙 Interliga Plus · R$ ${vPlus} _(SUV executivo)_\n` +
      `*3* — 🚐 Interliga Van · R$ ${vVan} _(até 8 pessoas)_\n\n` +
      `_Digite *cancelar* para voltar_`
    );
    return;
  }

  // ── CATEGORIA ──
  if (session.estado === 'CATEGORIA') {
    const cats = {
      '1': { nome: 'Interliga X', emoji: '🚗', valor: session.vX },
      '2': { nome: 'Interliga Plus', emoji: '🚙', valor: session.vPlus },
      '3': { nome: 'Interliga Van', emoji: '🚐', valor: session.vVan },
    };
    const cat = cats[txt];
    if (!cat) { await send('❓ Digite *1*, *2* ou *3* para escolher a categoria.'); return; }
    setSession(phone, { ...session, categoria: cat, estado: 'PAGAMENTO' });
    await send(
      `${cat.emoji} *${cat.nome}* · R$ ${cat.valor}\n\n` +
      `💳 *Forma de pagamento:*\n\n` +
      `*1* — 💚 Pix\n` +
      `*2* — 💳 Cartão\n` +
      `*3* — 💵 Dinheiro\n` +
      `*4* — 👛 Carteira Interliga`
    );
    return;
  }

  // ── PAGAMENTO ──
  if (session.estado === 'PAGAMENTO') {
    const pags = { '1': 'Pix 💚', '2': 'Cartão 💳', '3': 'Dinheiro 💵', '4': 'Carteira Interliga 👛' };
    const pag = pags[txt];
    if (!pag) { await send('❓ Digite *1*, *2*, *3* ou *4*.'); return; }
    setSession(phone, { ...session, pagamento: pag, estado: 'CONFIRMAR' });
    await send(
      `✅ *RESUMO DA CORRIDA*\n\n` +
      `🚩 ${session.embarqueNome}\n` +
      `🏁 ${session.destinoNome}\n` +
      `📏 ${session.km} km · ⏱️ ${session.min} min\n` +
      `${session.categoria.emoji} ${session.categoria.nome}\n` +
      `💰 *R$ ${session.categoria.valor}*\n` +
      `💳 ${pag}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `*1* — ✅ Confirmar corrida\n` +
      `*2* — ❌ Cancelar`
    );
    return;
  }

  // ── CONFIRMAR ──
  if (session.estado === 'CONFIRMAR') {
    if (txt === '2' || txt.includes('cancelar') || txt.includes('não')) {
      clearSession(phone);
      await send('❌ Corrida cancelada.\n\nDigite *oi* para solicitar uma nova corrida.');
      return;
    }
    if (txt === '1' || txt.includes('confirmar') || txt.includes('sim')) {
      const corridaId = 'C' + Date.now();
      setSession(phone, { ...session, corridaId, estado: 'BUSCANDO' });
      await send(`🔍 *Procurando motoristas próximos...*\n\nCorrida *#${corridaId}*\nAguarde alguns instantes! 🚗`);
      const motorista = await buscarMotorista();
      if (!motorista) {
        clearSession(phone);
        await send(`😔 *Nenhum motorista disponível* no momento.\n\nTente novamente em alguns minutos.\n\nDigite *1* para tentar novamente.`);
        setSession(phone, { estado: 'MENU' });
        return;
      }
      setSession(phone, { ...session, corridaId, motorista, estado: 'EM_CORRIDA' });
      await send(
        `🎉 *MOTORISTA ENCONTRADO!*\n\n` +
        `👨‍💼 *${motorista.nome}*\n` +
        `🚗 ${motorista.veiculo} · ${motorista.placa}\n` +
        `⭐ ${motorista.avaliacao}\n\n` +
        `📍 Acompanhe em:\n${CONFIG.APP_URL}\n\n` +
        `_Para cancelar, digite *cancelar*_`
      );
      return;
    }
    await send('Digite *1* para confirmar ou *2* para cancelar.');
    return;
  }

  // ── EM CORRIDA ──
  if (session.estado === 'EM_CORRIDA') {
    if (txt === 'cancelar' || txt === 'cancel') {
      clearSession(phone);
      await send(`❌ *Corrida cancelada.*\n\nDigite *oi* para solicitar uma nova corrida.`);
      return;
    }
    await send(`✅ Mensagem enviada ao motorista:\n_"${text}"_\n\n_Para cancelar, digite *cancelar*_`);
    return;
  }

  // ── AGENDAMENTO ──
  if (session.estado === 'AGENDAR_DATA') {
    setSession(phone, { ...session, dataAgendamento: text, estado: 'AGENDAR_EMBARQUE' });
    await send(`📅 Agendado para: *${text}*\n\n🚩 *PONTO DE EMBARQUE*\n\nInforme o endereço de embarque:`);
    return;
  }

  if (session.estado === 'AGENDAR_EMBARQUE') {
    setSession(phone, { ...session, embarque: text, estado: 'AGENDAR_DESTINO' });
    await send(`✅ Embarque: *${text}*\n\n🎯 *DESTINO*\n\nInforme o endereço de destino:`);
    return;
  }

  if (session.estado === 'AGENDAR_DESTINO') {
    const s = session;
    clearSession(phone);
    await send(
      `✅ *AGENDAMENTO CONFIRMADO!*\n\n` +
      `📅 *${s.dataAgendamento}*\n` +
      `🚩 ${s.embarque}\n` +
      `🏁 ${text}\n\n` +
      `Você receberá uma confirmação quando um motorista aceitar.\n\n` +
      `Digite *oi* para voltar ao menu.`
    );
    setSession(phone, { estado: 'MENU' });
    return;
  }

  // FALLBACK
  await send(`🤖 Não entendi. Digite *oi* para ver o menu ou *1* para solicitar uma corrida.`);
}

// ============================================================
// BAILEYS
// ============================================================
async function startBaileys() {
  console.log('🔄 Baileys iniciando...');
  try {
    const qrcode = require('qrcode');
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');
    const P = require('pino');
    const fs = require('fs');

    const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    console.log('✅ Versão Baileys:', (await fetchLatestBaileysVersion()).version.join('.'));

    sock = makeWASocket({
      version: (await fetchLatestBaileysVersion()).version,
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['Interliga Bot', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      getMessage: async (key) => {
        return { conversation: '' };
      },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        botStatus = 'aguardando_qr';
        console.log('📱 QR Code gerado!');
        try { qrCodeBase64 = await qrcode.toDataURL(qr); } catch(e) {}
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : null;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        lastError = `Desconectado. Código: ${code}`;
        console.log('🔴', lastError);
        botStatus = 'desconectado';
        qrCodeBase64 = null;
        if (shouldReconnect) {
          setTimeout(startBaileys, 5000);
        } else {
          const fs2 = require('fs');
          if (fs2.existsSync(AUTH_FOLDER)) fs2.readdirSync(AUTH_FOLDER).forEach(f => fs2.unlinkSync(`${AUTH_FOLDER}/${f}`));
          setTimeout(startBaileys, 3000);
        }
      }
      if (connection === 'open') {
        botStatus = 'conectado';
        qrCodeBase64 = null;
        lastError = '';
        console.log('✅ WhatsApp conectado!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.includes('@g.us')) continue;
        if (!jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) continue;
        const name = msg.pushName || 'Cliente';
        const m = msg.message;
        const text = m.conversation || m.extendedTextMessage?.text || '';
        if (!text) continue;
        console.log(`📨 [${jid}] ${name}: ${text}`);
        await processMessage(jid, text, name);
      }
    });

  } catch (e) {
    lastError = e.message;
    console.error('❌ Erro:', e.message);
    botStatus = 'erro';
    setTimeout(startBaileys, 10000);
  }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/qr', async (req, res) => {
  if (botStatus === 'conectado') return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>✅ WhatsApp Conectado!</h2><p>Bot online e funcionando.</p></body></html>`);
  if (botStatus === 'aguardando_qr' && qrCodeBase64) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>📱 Escaneie o QR Code</h2><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p><img src="${qrCodeBase64}" style="border:4px solid white;border-radius:8px;margin:20px auto;display:block;max-width:300px;"/><p style="color:#aaa;font-size:12px;">Atualize se expirar</p></body></html>`);
  return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>⏳ Aguardando QR Code...</h2><p>Status: <b>${botStatus}</b></p>${lastError ? `<p style="color:red;font-size:12px;">${lastError}</p>` : ''}<script>setTimeout(()=>location.reload(),4000)</script></body></html>`);
});
app.get('/', (req, res) => res.json({ status: botStatus, app: 'Interliga Bot', version: '3.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', botStatus }));

app.listen(PORT, () => {
  console.log(`🚀 Interliga Bot v3.0 na porta ${PORT}`);
  startBaileys();
});
