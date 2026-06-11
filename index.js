// INTERLIGA BOT v2.0 - Baileys
const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeBase64 = null;
let botStatus = 'iniciando';

// Iniciar Baileys de forma lazy
async function startBaileys() {
  try {
    const qrcode = require('qrcode');
    // firebase-admin removido — modo demo
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
    const { Boom } = require('@hapi/boom');
    const P = require('pino');
    const fs = require('fs');

    const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
    if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: true,
      browser: ['Interliga Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        botStatus = 'aguardando_qr';
        qrCodeBase64 = await qrcode.toDataURL(qr);
        console.log('📱 QR Code gerado!');
      }
      if (connection === 'close') {
        botStatus = 'desconectado';
        qrCodeBase64 = null;
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;
        if (shouldReconnect) setTimeout(startBaileys, 5000);
      }
      if (connection === 'open') {
        botStatus = 'conectado';
        qrCodeBase64 = null;
        console.log('✅ WhatsApp conectado!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        if (msg.key.remoteJid.includes('@g.us')) continue;
        const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const name = msg.pushName || 'Cliente';
        const m = msg.message;
        const text = m.conversation || m.extendedTextMessage?.text || '';
        if (!text) continue;
        console.log(`📨 [${phone}] ${name}: ${text}`);
        await sock.sendMessage(msg.key.remoteJid, {
          text: `👋 Olá *${name}*! Bem-vindo à *INTERLIGA* 🚗\n\n*1* — Solicitar corrida\n*2* — Agendar corrida\n*6* — Suporte\n\n_Digite o número da opção_`
        });
      }
    });

    console.log('🔄 Baileys iniciando...');
  } catch (e) {
    console.error('Erro ao iniciar Baileys:', e.message);
    botStatus = 'erro: ' + e.message;
    setTimeout(startBaileys, 10000);
  }
}

app.get('/qr', async (req, res) => {
  if (botStatus === 'conectado') {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>✅ WhatsApp Conectado!</h2><p>Bot online e funcionando.</p></body></html>`);
  }
  if (botStatus === 'aguardando_qr' && qrCodeBase64) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>📱 Escaneie o QR Code</h2><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p><img src="${qrCodeBase64}" style="border:4px solid white;border-radius:8px;margin:20px auto;display:block;max-width:300px;"/><p style="color:#aaa;font-size:12px;">Atualize se expirar</p></body></html>`);
  }
  return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>⏳ Aguardando QR Code...</h2><p>Status: ${botStatus}</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
});

app.get('/', (req, res) => res.json({ status: botStatus, app: 'Interliga Bot', version: '2.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', botStatus }));

app.listen(PORT, () => {
  console.log(`🚀 Interliga Bot rodando na porta ${PORT}`);
  startBaileys();
});
