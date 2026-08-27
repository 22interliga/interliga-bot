// ── FIX: Baileys precisa do crypto global no Node 18 ──
const { webcrypto } = require('crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const express = require('express');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── MÓDULO DE FRETE (carretas) ──
const { handleFreteMessage, watchDisparos, iniciarExpiracaoAutomatica } = require('./frete-bot-handler');
const admin = require('firebase-admin');

let freteDb = null;
if (process.env.FRETE_FIREBASE_KEY) {
  try {
    const freteApp = admin.initializeApp(
      { credential: admin.credential.cert(JSON.parse(process.env.FRETE_FIREBASE_KEY)) },
      'frete'
    );
    freteDb = freteApp.firestore();
    console.log('✅ Firebase do frete conectado');
  } catch (e) {
    console.error('❌ Erro ao conectar Firebase do frete:', e.message);
  }
} else {
  console.log('ℹ️ FRETE_FIREBASE_KEY não configurada — módulo de frete desativado');
}

let sock = null;
let qrCodeBase64 = null;
let botStatus = 'iniciando';
let lastError = '';

// ── Corridas em memória (fallback se Firebase não configurado) ──
let corridasPendentes = [];
let corridasHistorico = [];

async function startBaileys() {
  console.log('🔄 Baileys iniciando...');
  try {
    const qrcode = require('qrcode');
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');
    const P = require('pino');
    const fs = require('fs');

    // ── AUTH PERSISTENTE: usa /data se existir (Railway Volume), senão ./auth_info ──
    const AUTH_FOLDER = fs.existsSync('/data') ? '/data/auth_info' : (process.env.AUTH_FOLDER || './auth_info');
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    console.log('📂 Auth folder:', AUTH_FOLDER);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    console.log('✅ Auth state carregado');

    const { version } = await fetchLatestBaileysVersion();
    console.log('✅ Versão Baileys:', version.join('.'));

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'warn' }),
      printQRInTerminal: true,
      browser: ['Interliga Bot', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('📡 Connection update:', JSON.stringify({ connection, hasQR: !!qr }));

      if (qr) {
        botStatus = 'aguardando_qr';
        console.log('📱 QR Code gerado! Acesse /qr');
        try { qrCodeBase64 = await qrcode.toDataURL(qr); } catch(e) {}
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode : null;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        lastError = `Desconectado. Código: ${code}`;
        botStatus = 'desconectado';
        qrCodeBase64 = null;
        if (shouldReconnect) {
          console.log('⏳ Reconectando em 5s...');
          setTimeout(startBaileys, 5000);
        } else {
          // Sessão encerrada pelo usuário — limpa auth
          console.log('🚪 Sessão encerrada. Limpando auth...');
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.readdirSync(AUTH_FOLDER).forEach(f => {
              try { fs.unlinkSync(`${AUTH_FOLDER}/${f}`); } catch(e) {}
            });
          }
          setTimeout(startBaileys, 3000);
        }
      }

      if (connection === 'open') {
        botStatus = 'conectado';
        qrCodeBase64 = null;
        lastError = '';
        console.log('✅ WhatsApp conectado!');

        // Ativa o monitor de disparos de frete (cargas cadastradas no painel)
        if (freteDb) {
          watchDisparos(sock, freteDb);
          iniciarExpiracaoAutomatica(freteDb);
          console.log('✅ Monitor de cargas de frete ativado');
        }
      }
    });

    // ── Sessões de chat por usuário ──
    const sessoes = {};

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        if (msg.key.remoteJid.includes('@g.us')) continue;

        const jid   = msg.key.remoteJid;
        const phone = jid.replace('@s.whatsapp.net', '');
        const name  = msg.pushName || 'Cliente';
        const m     = msg.message;
        const text  = (m.conversation || m.extendedTextMessage?.text || '').trim();
        if (!text) continue;

        console.log(`📨 [${phone}] ${name}: ${text}`);

        // ── Verifica primeiro se é um motorista de frete (carreta) cadastrado ──
        // Se for, o módulo de frete assume a conversa e não passa pro fluxo do Interliga.
        if (freteDb) {
          try {
            const tratadoPeloFrete = await handleFreteMessage(sock, phone, text, freteDb);
            if (tratadoPeloFrete) continue;
          } catch (e) {
            console.error('❌ Erro no módulo de frete:', e.message);
          }
        }

        if (!sessoes[phone]) sessoes[phone] = { estado: 'inicio', dados: {} };
        const s = sessoes[phone];

        const reply = async (txt) => {
          await sock.sendMessage(jid, { text: txt });
        };

        // ── Fluxo de corrida ──
        const textLower = text.toLowerCase();

        // Verificar se é mensagem do app (começa com [Interliga])
        if (text.startsWith('[Interliga]') || text.startsWith('🚗 *NOVA CORRIDA')) {
          // Notificar motoristas disponíveis
          await reply('✅ Corrida registrada! Procurando motorista...');
          continue;
        }

        // Menu principal
        if (s.estado === 'inicio' || text === '0' || textLower.includes('menu') || textLower.includes('voltar')) {
          s.estado = 'menu';
          s.dados = {};
          await reply(
            `👋 Olá *${name}*! Bem-vindo à *INTERLIGA* 🚗\n\n` +
            `*1* — 🚗 Solicitar corrida\n` +
            `*2* — 📅 Agendar corrida\n` +
            `*3* — 📋 Minhas corridas\n` +
            `*6* — 🎧 Suporte\n\n` +
            `_Digite o número da opção_`
          );
          continue;
        }

        // Opção 1 — Solicitar corrida
        if (s.estado === 'menu' && (text === '1' || textLower.includes('corrida'))) {
          s.estado = 'aguardando_origem';
          await reply('📍 *De onde você vai sair?*\n\nDigite o endereço de embarque:\n_(Ex: Rua das Flores, 123 — Madre de Deus)_');
          continue;
        }

        if (s.estado === 'aguardando_origem') {
          s.dados.origem = text;
          s.estado = 'aguardando_destino';
          await reply(`✅ Origem: *${text}*\n\n🎯 *Para onde você vai?*\n\nDigite o destino:`);
          continue;
        }

        if (s.estado === 'aguardando_destino') {
          s.dados.destino = text;
          s.estado = 'aguardando_confirmacao';

          // Calcular valor estimado simples
          const valor = 'R$ 12,00 ~ R$ 18,00';
          s.dados.valor = valor;

          await reply(
            `🗺️ *Resumo da corrida:*\n\n` +
            `📍 *Origem:* ${s.dados.origem}\n` +
            `🎯 *Destino:* ${s.dados.destino}\n` +
            `💰 *Valor estimado:* ${valor}\n\n` +
            `Confirmar corrida?\n*1* — ✅ Confirmar\n*2* — ❌ Cancelar`
          );
          continue;
        }

        if (s.estado === 'aguardando_confirmacao') {
          if (text === '1' || textLower.includes('confirm') || textLower.includes('sim')) {
            const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const corrida = {
              id: Date.now(),
              passageiroNome: name,
              passageiroPhone: phone,
              origem: s.dados.origem,
              destino: s.dados.destino,
              valor: s.dados.valor,
              hora,
              status: 'aguardando',
              ts: new Date().toISOString()
            };
            corridasPendentes.push(corrida);
            s.estado = 'corrida_ativa';
            s.dados.corridaId = corrida.id;

            await reply(
              `✅ *Corrida confirmada!*\n\n` +
              `🔍 Procurando motorista...\n` +
              `⏱ Aguarde, você será notificado em instantes!\n\n` +
              `_Corrida #${corrida.id}_\n\n` +
              `Digite *0* para voltar ao menu`
            );
          } else {
            s.estado = 'menu';
            await reply('❌ Corrida cancelada.\n\nDigite *1* para solicitar nova corrida.');
          }
          continue;
        }

        // Opção 2 — Agendar
        if (s.estado === 'menu' && text === '2') {
          s.estado = 'agendando_origem';
          await reply('📅 *Agendar corrida*\n\n📍 De onde você vai sair?');
          continue;
        }

        if (s.estado === 'agendando_origem') {
          s.dados.origem = text;
          s.estado = 'agendando_destino';
          await reply(`✅ Origem: *${text}*\n\n🎯 Para onde vai?`);
          continue;
        }

        if (s.estado === 'agendando_destino') {
          s.dados.destino = text;
          s.estado = 'agendando_data';
          await reply('📆 Qual data e horário?\n_(Ex: Amanhã às 14h, 15/06 às 9h)_');
          continue;
        }

        if (s.estado === 'agendando_data') {
          s.dados.dataHora = text;
          s.estado = 'menu';
          await reply(
            `✅ *Agendamento confirmado!*\n\n` +
            `📍 *Origem:* ${s.dados.origem}\n` +
            `🎯 *Destino:* ${s.dados.destino}\n` +
            `📆 *Data/Hora:* ${s.dados.dataHora}\n\n` +
            `Entraremos em contato para confirmar o motorista!\n\n` +
            `Digite *0* para voltar ao menu`
          );
          continue;
        }

        // Opção 3 — Minhas corridas
        if (s.estado === 'menu' && text === '3') {
          const minhas = corridasHistorico.filter(c => c.passageiroPhone === phone);
          if (minhas.length === 0) {
            await reply('📋 Você ainda não tem corridas realizadas.\n\nDigite *1* para solicitar uma corrida!');
          } else {
            const lista = minhas.slice(0, 3).map(c =>
              `🚗 ${c.origem} → ${c.destino}\n💰 ${c.valor} · ${c.hora}`
            ).join('\n\n');
            await reply(`📋 *Suas últimas corridas:*\n\n${lista}\n\nDigite *0* para voltar ao menu`);
          }
          s.estado = 'menu';
          continue;
        }

        // Opção 6 — Suporte
        if (text === '6' || textLower.includes('suporte')) {
          s.estado = 'menu';
          await reply(
            `🎧 *Suporte Interliga*\n\n` +
            `📞 WhatsApp: (71) 98189-9571\n` +
            `🌐 App: 22interliga.github.io/interliga\n\n` +
            `_Nossa equipe responde em até 30 minutos_\n\n` +
            `Digite *0* para voltar ao menu`
          );
          continue;
        }

        // Resposta padrão
        if (s.estado === 'menu' || s.estado === 'inicio') {
          await reply(
            `❓ Não entendi. Digite:\n\n` +
            `*1* — 🚗 Solicitar corrida\n` +
            `*2* — 📅 Agendar\n` +
            `*0* — 🏠 Menu principal`
          );
          s.estado = 'menu';
        }
      }
    });

  } catch (e) {
    lastError = e.message;
    console.error('❌ Erro ao iniciar Baileys:', e.message);
    botStatus = 'erro';
    setTimeout(startBaileys, 10000);
  }
}

// ── ENDPOINTS ──

app.get('/qr', async (req, res) => {
  if (botStatus === 'conectado') {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>✅ WhatsApp Conectado!</h2><p>Bot online e funcionando.</p><p style="color:#4ade80;">Status: ONLINE</p></body></html>`);
  }
  if (botStatus === 'aguardando_qr' && qrCodeBase64) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>📱 Escaneie o QR Code</h2><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p><img src="${qrCodeBase64}" style="border:4px solid white;border-radius:8px;margin:20px auto;display:block;max-width:300px;"/><p style="color:#aaa;font-size:12px;">Atualiza automaticamente em 10s</p><script>setTimeout(()=>location.reload(),10000)</script></body></html>`);
  }
  return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>⏳ Iniciando bot...</h2><p>Status: <b>${botStatus}</b></p>${lastError ? `<p style="color:red;">Erro: ${lastError}</p>` : ''}<script>setTimeout(()=>location.reload(),4000)</script></body></html>`);
});

app.get('/', (req, res) => res.json({ status: botStatus, app: 'Interliga Bot', version: '3.0.0', freteAtivo: !!freteDb }));
app.get('/health', (req, res) => res.json({ status: 'ok', botStatus, corridasPendentes: corridasPendentes.length }));

// Corridas pendentes (consultado pelo app do motorista)
app.get('/corridas-pendentes', (req, res) => {
  res.json(corridasPendentes.filter(c => c.status === 'aguardando'));
});

// Motorista aceita corrida
app.post('/aceitar-corrida', async (req, res) => {
  const { corridaId, motoristaNome, motoristaVeiculo, motoristaPlaca, motoristaAvaliacao } = req.body;
  const corrida = corridasPendentes.find(c => c.id == corridaId);
  if (!corrida) return res.json({ ok: false, msg: 'Corrida não encontrada' });

  corrida.status = 'aceita';
  corrida.motorista = { nome: motoristaNome, veiculo: motoristaVeiculo, placa: motoristaPlaca, avaliacao: motoristaAvaliacao };
  corridasHistorico.push(corrida);
  corridasPendentes = corridasPendentes.filter(c => c.id != corridaId);

  // Notificar passageiro via WhatsApp
  if (sock && botStatus === 'conectado' && corrida.passageiroPhone) {
    try {
      const jid = corrida.passageiroPhone + '@s.whatsapp.net';
      await sock.sendMessage(jid, {
        text:
          `✅ *MOTORISTA ACEITOU SUA CORRIDA!*\n\n` +
          `🚗 *${motoristaNome}*\n` +
          `🚘 ${motoristaVeiculo} · ${motoristaPlaca}\n` +
          `⭐ Avaliação: ${motoristaAvaliacao}\n` +
          `⏱ Chegando em ~4 minutos\n\n` +
          `_Acompanhe pelo app Interliga_`
      });
    } catch(e) { console.error('Erro ao notificar passageiro:', e.message); }
  }

  res.json({ ok: true, msg: 'Corrida aceita e passageiro notificado!' });
});

// Finalizar corrida
app.post('/finalizar-corrida', async (req, res) => {
  const { corridaId } = req.body;
  const corrida = corridasHistorico.find(c => c.id == corridaId);
  if (corrida) corrida.status = 'finalizada';

  if (sock && botStatus === 'conectado' && corrida?.passageiroPhone) {
    try {
      const jid = corrida.passageiroPhone + '@s.whatsapp.net';
      await sock.sendMessage(jid, {
        text:
          `🏁 *Corrida finalizada!*\n\n` +
          `📍 ${corrida.origem} → ${corrida.destino}\n` +
          `💰 *Valor: ${corrida.valor}*\n\n` +
          `Obrigado por usar a *Interliga*! ⭐\n` +
          `Como foi sua experiência? Digite *1* a *5*`
      });
    } catch(e) {}
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Interliga Bot v3.0 rodando na porta ${PORT}`);
  startBaileys();
});
//redeploy

