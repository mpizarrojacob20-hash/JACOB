// api/daily-checkin.js — Disparado por Vercel Cron todos los días. Le manda a cada
// cliente en CLIENTES un mensaje proactivo por WhatsApp sugiriendo qué revisar hoy con
// Jacob (recordando su acción pendiente más relevante, o invitándolo a compartir
// números nuevos si no tiene ninguna).
import {
  listAllClients,
  generateDailyNudge,
  clientPhone,
  clientTelegramChatId,
  neverContacted,
} from "../lib/jacob-core.js";
import { sendWhatsAppMessageChunked, sendWhatsAppTemplate } from "../lib/twilio.js";
import { sendTelegramMessage } from "../lib/telegram.js";

// SID de la plantilla "bienvenida_jacob" (Content Template Builder de Twilio), la
// única forma de escribirle primero a alguien que nunca ha hablado con Jacob — WhatsApp
// bloquea texto libre fuera de la ventana de 24h, y alguien nunca contactado nunca tuvo
// esa ventana abierta.
const WELCOME_TEMPLATE_SID = "HX79f89c7faeca696ff7e946805aa1bf4a";

export default async function handler(req, res) {
  const {
    CRON_SECRET,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_NUMBER,
    TELEGRAM_BOT_TOKEN,
  } = process.env;

  // Vercel manda `Authorization: Bearer <CRON_SECRET>` automáticamente en los cron
  // jobs cuando esa env var está configurada — así nadie más puede disparar esto
  // pegándole a la URL a mano.
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  const {
    ANTHROPIC_API_KEY,
    NOTION_TOKEN,
    NOTION_CLIENTES_DB,
    NOTION_ACCIONES_DB,
  } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_NUMBER) {
    res.status(500).json({ error: "Faltan variables TWILIO_*" });
    return;
  }
  if (!ANTHROPIC_API_KEY || !NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_ACCIONES_DB) {
    res.status(500).json({ error: "Falta configuración de Anthropic/Notion" });
    return;
  }

  const env = { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB };
  const clients = await listAllClients(NOTION_TOKEN, NOTION_CLIENTES_DB);

  const results = [];
  for (const clientPage of clients) {
    const telefono = clientPhone(clientPage);
    const telegramChatId = clientTelegramChatId(clientPage);
    try {
      if (telegramChatId && TELEGRAM_BOT_TOKEN) {
        // Telegram no tiene la ventana de 24h ni exige plantillas — se le puede
        // escribir directo siempre, a diferencia de WhatsApp.
        const nudge = await generateDailyNudge({ clientPage, env });
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, telegramChatId, nudge);
        results.push({ telefono, ok: true, tipo: "nudge-telegram" });
      } else if (neverContacted(clientPage)) {
        // Nunca hubo ventana de 24h abierta con este cliente — texto libre fallaría
        // (error 63016). La plantilla es la única forma de escribirle primero.
        await sendWhatsAppTemplate(
          TWILIO_ACCOUNT_SID,
          TWILIO_AUTH_TOKEN,
          `whatsapp:${telefono}`,
          TWILIO_WHATSAPP_NUMBER,
          WELCOME_TEMPLATE_SID
        );
        results.push({ telefono, ok: true, tipo: "bienvenida" });
      } else {
        const nudge = await generateDailyNudge({ clientPage, env });
        await sendWhatsAppMessageChunked(
          TWILIO_ACCOUNT_SID,
          TWILIO_AUTH_TOKEN,
          `whatsapp:${telefono}`,
          TWILIO_WHATSAPP_NUMBER,
          nudge
        );
        results.push({ telefono, ok: true, tipo: "nudge" });
      }
    } catch (err) {
      console.error(`daily-checkin: error con ${telefono}:`, err);
      results.push({ telefono, ok: false, error: err.message });
    }
  }

  res.status(200).json({
    total: clients.length,
    enviados: results.filter((r) => r.ok).length,
    fallidos: results.filter((r) => !r.ok),
  });
}
