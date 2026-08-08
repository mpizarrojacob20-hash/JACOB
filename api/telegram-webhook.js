// api/telegram-webhook.js — Canal alternativo mientras la verificación de negocio de
// Meta sigue pendiente. Mismo cerebro que WhatsApp (lib/jacob-core.js); la única
// diferencia real es la identidad: CLIENTES sigue indexado por teléfono, así que un
// chat de Telegram nuevo se vincula pidiendo el número una vez y guardándolo en
// telegram_chat_id — de ahí en adelante el lookup es directo.
import { waitUntil } from "@vercel/functions";
import {
  processMessage,
  clientPhone,
  findClientByPhone,
  findClientByTelegramId,
  linkTelegramChatId,
} from "../lib/jacob-core.js";
import { sendTelegramMessage, EXAMPLES_KEYBOARD } from "../lib/telegram.js";

const PHONE_RE = /^\+?[\d\s-]{8,}$/;

const WELCOME_TEXT = `Hola 👋 Soy Jacob — tu contador, CFO, auditor interno y administrador, todo en este chat.

📋 *Contador* — interpreto tus estados financieros y tus gastos
📊 *CFO* — comparo tus márgenes contra tu industria y te ayudo a decidir dónde poner la plata
🔎 *Auditor interno* — detecto focos rojos antes de que te cuesten caro
🧭 *Administrador* — ordeno quién decide qué, para que no dependa todo de ti

Para conectarte, mándame tu número de teléfono registrado (el mismo que usas normalmente con Jacob).`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const {
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET,
    ANTHROPIC_API_KEY,
    NOTION_TOKEN,
    NOTION_CLIENTES_DB,
    NOTION_ACCIONES_DB,
  } = process.env;

  if (TELEGRAM_WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== TELEGRAM_WEBHOOK_SECRET) {
    res.status(403).end();
    return;
  }

  // Ack inmediato — igual que whatsapp-webhook.js, Vercel corta la función apenas se
  // manda la respuesta salvo que se use waitUntil para seguir trabajando después.
  res.status(200).end();

  const message = req.body?.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (!chatId || !text) return;

  const env = { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB };

  waitUntil(
    (async () => {
      try {
        const linkedClient = await findClientByTelegramId(NOTION_TOKEN, NOTION_CLIENTES_DB, chatId);

        if (!linkedClient) {
          if (text === "/ejemplos") {
            await sendTelegramMessage(
              TELEGRAM_BOT_TOKEN,
              chatId,
              "Todavía no estás conectado — mándame primero tu número de teléfono registrado."
            );
            return;
          }
          if (PHONE_RE.test(text)) {
            const candidate = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, text);
            if (candidate) {
              await linkTelegramChatId(NOTION_TOKEN, candidate.id, chatId);
              await sendTelegramMessage(
                TELEGRAM_BOT_TOKEN,
                chatId,
                "Listo, quedaste conectado ✅ Cuéntame en qué te ayudo, mándame tus números para partir, o toca uno de estos:",
                { replyMarkup: EXAMPLES_KEYBOARD }
              );
            } else {
              await sendTelegramMessage(
                TELEGRAM_BOT_TOKEN,
                chatId,
                "Ese número no está registrado como cliente de Jacob. Si eres cliente, avísale a Martín para que te active el acceso."
              );
            }
            return;
          }
          await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, WELCOME_TEXT, { markdown: true });
          return;
        }

        if (text === "/ejemplos") {
          await sendTelegramMessage(
            TELEGRAM_BOT_TOKEN,
            chatId,
            "Toca uno para partir, o escríbeme directo lo que necesites:",
            { replyMarkup: EXAMPLES_KEYBOARD }
          );
          return;
        }

        const telefono = clientPhone(linkedClient);
        const result = await processMessage({ telefono, mensaje: text, env });
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, result.reply);
      } catch (err) {
        console.error("telegram-webhook error:", err);
        await sendTelegramMessage(
          TELEGRAM_BOT_TOKEN,
          chatId,
          "Tuve un problema técnico procesando tu mensaje. Intenta de nuevo en unos minutos."
        ).catch(() => {});
      }
    })()
  );
}
