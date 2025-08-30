const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
require('dotenv').config();
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const qrcode = require('qrcode-terminal');
ffmpeg.setFfmpegPath(ffmpegPath);

// Configuração dos clientes da OpenAI e do Google AI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Escolha o modelo do Gemini

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Usando a versão do Baileys: ${version.join('.')}, É a mais recente: ${isLatest}`);

    const sock = makeWASocket({
        version,
        auth: state,
        // A OPÇÃO 'printQRInTerminal' FOI REMOVIDA DAQUI
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // A LÓGICA AQUI FOI ALTERADA
        if(qr) {
            console.log('QR Code recebido, leia abaixo:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada devido a ', lastDisconnect.error, ', reconectando ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Conexão aberta com sucesso!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const messageType = Object.keys(msg.message)[0];
        const sender = msg.key.remoteJid;

        try {
            let inputText = '';

            if (messageType === 'conversation') {
                inputText = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                inputText = msg.message.extendedTextMessage.text;
            } else if (messageType === 'audioMessage') {
                const { streamToBuffer } = require('@whiskeysockets/baileys');
                const buffer = await streamToBuffer(await sock.downloadMediaMessage(msg));
                const audioFilePath = `./temp_audio.ogg`;
                const outputFilePath = `./temp_audio.mp3`;

                fs.writeFileSync(audioFilePath, buffer);

                await new Promise((resolve, reject) => {
                    ffmpeg(audioFilePath)
                        .toFormat('mp3')
                        .on('end', () => resolve())
                        .on('error', (err) => reject(err))
                        .save(outputFilePath);
                });

                const transcription = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(outputFilePath),
                    model: "whisper-1",
                });

                inputText = transcription.text;
                fs.unlinkSync(audioFilePath);
                fs.unlinkSync(outputFilePath);
            }

            if (inputText) {
                console.log(`Texto para o Gemini de ${sender}: ${inputText}`);

                const result = await model.generateContent(inputText);
                const response = await result.response;
                const textResponse = response.text();

                await sock.sendMessage(sender, { text: textResponse });
                console.log(`Resposta do Gemini enviada para ${sender}: ${textResponse}`);
            }

        } catch (error) {
            console.error("Erro ao processar mensagem:", error);
            await sock.sendMessage(sender, { text: 'Desculpe, ocorreu um erro ao processar sua solicitação.' });
        }
    });

    return sock;
}

// Inicie a conexão
connectToWhatsApp();