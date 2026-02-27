import { Bot, Context, webhookCallback } from 'grammy';
import http from 'http';
import {
    ASSISTANT_NAME,
    TELEGRAM_BOT_TOKEN,
    PORT,
} from '../config.js';
import { logger } from '../logger.js';
import {
    Channel,
    OnInboundMessage,
    OnChatMetadata,
    RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
    name = 'telegram';
    private bot: Bot;
    private connected = false;
    private opts: TelegramChannelOpts;
    private server?: http.Server;

    constructor(opts: TelegramChannelOpts) {
        this.opts = opts;
        if (!TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN is not set');
        }
        this.bot = new Bot(TELEGRAM_BOT_TOKEN);
        this.setupHandlers();
    }

    private setupHandlers() {
        this.bot.on('message:text', async (ctx) => {
            const chatJid = `tg:${ctx.chat.id}`;
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

            this.opts.onChatMetadata(
                chatJid,
                timestamp,
                ctx.chat.type === 'private' ? ctx.from?.first_name : ctx.chat.title,
                'telegram',
                isGroup
            );

            const groups = this.opts.registeredGroups();
            if (groups[chatJid]) {
                const sender = ctx.from?.id ? `tg:${ctx.from.id}` : chatJid;
                const senderName = ctx.from?.first_name || 'User';
                const content = ctx.message.text || '';

                // Simplistic bot message detection: message from the bot itself is usually not received via this handler
                // but if we use a shared number pattern, we check prefix.
                // In Telegram, bots don't receive their own messages unless they are admin and 
                // specialized settings are on, but we follow the existing pattern.
                const isBotMessage = content.startsWith(`${ASSISTANT_NAME}:`);

                this.opts.onMessage(chatJid, {
                    id: ctx.message.message_id.toString(),
                    chat_jid: chatJid,
                    sender,
                    sender_name: senderName,
                    content,
                    timestamp,
                    is_from_me: false, // Messages received by the bot are not from the bot
                    is_bot_message: isBotMessage,
                });
            }
        });
    }

    async connect(): Promise<void> {
        const handler = webhookCallback(this.bot, 'http');

        this.server = http.createServer(async (req, res) => {
            if (req.method === 'POST') {
                return handler(req, res);
            } else if (req.method === 'GET' && req.url === '/') {
                res.writeHead(200);
                res.end('NanoClaw Telegram Bot is running');
                return;
            }
            res.writeHead(404);
            res.end();
        });

        return new Promise((resolve) => {
            this.server?.listen(PORT, () => {
                this.connected = true;
                logger.info({ port: PORT }, 'Telegram webhook server listening');
                resolve();
            });
        });
    }

    async sendMessage(jid: string, text: string): Promise<void> {
        const chatId = parseInt(jid.replace('tg:', ''), 10);
        // Don't prefix with Assistant Name on Telegram if it's a private chat? 
        // The existing WhatsApp implementation prefixes it.
        // Let's keep consistency with the user prompt's request for "bespoke" and 
        // "clean code", but the base project prefixes messages.
        // I will stick to the base project's behavior for now unless it feels wrong.
        // Actually, on Telegram, users expect messages to come from the bot's identity directly.
        // But index.ts already handles prefixing or passing raw text? 
        // No, whatsapp.ts handle prefixing.

        // In NanoClaw, index.ts calls channel.sendMessage(jid, text).
        // whatsapp.ts line 240: const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;

        // I'll skip the prefix on Telegram because Telegram is bot-native.
        try {
            await this.bot.api.sendMessage(chatId, text);
            logger.info({ jid, length: text.length }, 'Telegram message sent');
        } catch (err) {
            logger.error({ jid, err }, 'Failed to send Telegram message');
        }
    }

    isConnected(): boolean {
        return this.connected;
    }

    ownsJid(jid: string): boolean {
        return jid.startsWith('tg:');
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        return new Promise((resolve) => {
            this.server?.close(() => resolve());
        });
    }

    async setTyping(jid: string, isTyping: boolean): Promise<void> {
        if (!isTyping) return;
        const chatId = parseInt(jid.replace('tg:', ''), 10);
        try {
            await this.bot.api.sendChatAction(chatId, 'typing');
        } catch (err) {
            logger.debug({ jid, err }, 'Failed to set Telegram typing status');
        }
    }
}
