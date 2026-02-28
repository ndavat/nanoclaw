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
            const sender = ctx.from?.id ? `tg:${ctx.from.id}` : chatJid;
            const senderName = ctx.from?.first_name || 'User';
            const content = ctx.message.text || '';

            logger.info({ chatJid, senderName, isRegistered: !!groups[chatJid] }, 'Telegram message received');

            const isBotMessage = content.startsWith(`${ASSISTANT_NAME}:`);

            this.opts.onMessage(chatJid, {
                id: ctx.message.message_id.toString(),
                chat_jid: chatJid,
                sender,
                sender_name: senderName,
                content,
                timestamp,
                is_from_me: false,
                is_bot_message: isBotMessage,
            });
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
            } else if (req.method === 'GET' && req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'ok',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                }));
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

        // Convert basic markdown to HTML for stable Telegram formatting
        const mdToHtml = (str: string) => {
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\*\*\*(.*?)\*\*\*/g, '<b><i>$1</i></b>')
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
                .replace(/\*(.*?)\*/g, '<b>$1</b>')
                .replace(/__(.*?)__/g, '<i>$1</i>')
                .replace(/_(.*?)_/g, '<i>$1</i>')
                .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
                .replace(/`(.*?)`/g, '<code>$1</code>');
        };

        const htmlText = mdToHtml(text);

        try {
            await this.bot.api.sendMessage(chatId, htmlText, {
                parse_mode: 'HTML',
            });
            logger.info({ jid, length: text.length }, 'Telegram message sent (HTML)');
        } catch (err) {
            logger.warn({ jid, err }, 'Failed to send as HTML, falling back to plain text');
            try {
                await this.bot.api.sendMessage(chatId, text);
                logger.info({ jid, length: text.length }, 'Telegram message sent (Plain Text fallback)');
            } catch (err2) {
                logger.error({ jid, err: err2 }, 'Failed to send Telegram message even as plain text');
            }
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
