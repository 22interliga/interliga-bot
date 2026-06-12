// Fix: crypto necessário para o Baileys
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

const express = require('express');
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeBase64 = null;
let botStatus = 'iniciando';
let lastError = '';

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
        try {
          qrCodeBase64 = await qrcode.toDataURL(qr);
        } catch(e) {
          console.error('Erro ao gerar QR:', e.message);
        }
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : null;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        lastError = `Desconectado. Código: ${code}. Reconectar: ${shouldReconnect}`;
        console.log('🔴', lastError);
        botStatus = 'desconectado';
        qrCodeBase64 = null;
        if (shouldReconnect) {
          console.log('⏳ Reconectando em 5s...');
          setTimeout(startBaileys, 5000);
        } else {
          console.log('🚪 Sessão encerrada. Limpando auth...');
          const fs2 = require('fs');
          if (fs2.existsSync(AUTH_FOLDER)) {
            fs2.readdirSync(AUTH_FOLDER).forEach(f => fs2.unlinkSync(`${AUTH_FOLDER}/${f}`));
          }
          setTimeout(startBaileys, 3000);
        }
      }

      if (connection === 'open') {
        botStatus = 'conectado';
        qrCodeBase64 = null;
        lastError = '';
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;
        // Aceitar @s.whatsapp.net e @lid (novo formato WhatsApp)
        const jid = msg.key.remoteJid || '';
        if (jid.includes('@g.us')) continue; // ignorar grupos
        if (!jid.includes('@s.whatsapp.net') && !jid.includes('@lid')) continue;
        
        const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const name = msg.pushName || 'Cliente';
        const m = msg.message;
        const text = m.conversation || m.extendedTextMessage?.text || '';
        if (!text) continue;
        console.log(`📨 [${phone}] ${name}: ${text}`);
        // Usar o JID original para responder
        await sock.sendMessage(jid, {
          text: `👋 Olá *${name}*! Bem-vindo à *INTERLIGA* 🚗\n\n*1* — Solicitar corrida\n*2* — Agendar corrida\n*6* — Suporte\n\n_Digite o número da opção_`
        });
      }
    });

  } catch (e) {
    lastError = e.message;
    console.error('❌ Erro ao iniciar Baileys:', e.message);
    console.error(e.stack);
    botStatus = 'erro';
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
  return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0a0a0a;color:white;"><h2>⏳ Aguardando QR Code...</h2><p>Status: <b>${botStatus}</b></p>${lastError ? `<p style="color:red;font-size:12px;">Erro: ${lastError}</p>` : ''}<script>setTimeout(()=>location.reload(),4000)</script></body></html>`);
});

app.get('/', (req, res) => res.json({ status: botStatus, app: 'Interliga Bot', version: '2.0.0', error: lastError || undefined }));
app.get('/health', (req, res) => res.json({ status: 'ok', botStatus, lastError }));

app.listen(PORT, () => {
  console.log(`🚀 Interliga Bot rodando na porta ${PORT}`);
  startBaileys();
});
