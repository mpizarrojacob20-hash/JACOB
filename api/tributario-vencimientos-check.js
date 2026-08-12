// api/tributario-vencimientos-check.js — Módulo tributario, función 3 (alertas de
// vencimientos). Disparado por Vercel Cron una vez al día: revisa VENCIMIENTOS y manda
// el recordatorio que corresponda (5 días antes, 1 día antes, el mismo día), por el
// mismo canal preferido que daily-checkin.js (Telegram si el cliente está vinculado,
// si no WhatsApp).
import { clientPhone, clientTelegramChatId } from "../lib/jacob-core.js";
import { checkVencimientos, markVencimientoRecordatorio } from "../lib/tributario.js";
import { sendWhatsAppMessageChunked } from "../lib/twilio.js";
import { sendTelegramMessage } from "../lib/telegram.js";

export default async function handler(req, res) {
  const {
    CRON_SECRET,
    NOTION_TOKEN,
    NOTION_CLIENTES_DB,
    NOTION_VENCIMIENTOS_DB,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_NUMBER,
    TELEGRAM_BOT_TOKEN,
  } = process.env;

  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_VENCIMIENTOS_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const avisos = await checkVencimientos(NOTION_TOKEN, {
    clientesDb: NOTION_CLIENTES_DB,
    vencimientosDb: NOTION_VENCIMIENTOS_DB,
  });

  const results = [];
  for (const aviso of avisos) {
    const telegramChatId = clientTelegramChatId(aviso.clientPage);
    const telefono = clientPhone(aviso.clientPage);
    try {
      if (telegramChatId && TELEGRAM_BOT_TOKEN) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, telegramChatId, aviso.mensaje);
      } else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_NUMBER) {
        await sendWhatsAppMessageChunked(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, `whatsapp:${telefono}`, TWILIO_WHATSAPP_NUMBER, aviso.mensaje);
      } else {
        throw new Error("Sin canal disponible (ni Telegram ni WhatsApp configurados)");
      }
      await markVencimientoRecordatorio(NOTION_TOKEN, aviso.vencimientoId, aviso.tier, aviso.yaEnviados);
      results.push({ telefono, tier: aviso.tier, ok: true });
    } catch (err) {
      console.error(`vencimientos-check: error con ${telefono}:`, err);
      results.push({ telefono, tier: aviso.tier, ok: false, error: err.message });
    }
  }

  res.status(200).json({ revisados: avisos.length, enviados: results.filter((r) => r.ok).length, resultados: results });
}
