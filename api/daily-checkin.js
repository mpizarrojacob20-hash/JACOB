// api/daily-checkin.js — Disparado por Vercel Cron todos los días. Le manda a cada
// cliente en CLIENTES un mensaje proactivo por WhatsApp sugiriendo qué revisar hoy con
// Jacob (recordando su acción pendiente más relevante, o invitándolo a compartir
// números nuevos si no tiene ninguna).
import { listAllClients, generateDailyNudge, clientPhone } from "../lib/jacob-core.js";
import { sendWhatsAppMessageChunked } from "../lib/twilio.js";

export default async function handler(req, res) {
  const { CRON_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER } = process.env;

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
    try {
      const nudge = await generateDailyNudge({ clientPage, env });
      await sendWhatsAppMessageChunked(
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        `whatsapp:${telefono}`,
        TWILIO_WHATSAPP_NUMBER,
        nudge
      );
      results.push({ telefono, ok: true });
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
