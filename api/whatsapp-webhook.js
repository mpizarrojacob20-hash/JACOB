// api/whatsapp-webhook.js — Recibe mensajes entrantes de WhatsApp vía Twilio.
// Valida la firma de Twilio, reusa la misma lógica que jacob-agent.js
// (lib/jacob-core.js) y responde en formato TwiML.
import crypto from "node:crypto";
import { processMessage } from "../lib/jacob-core.js";

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

// Algoritmo de validación de Twilio: HMAC-SHA1(url + params ordenados y concatenados)
// con el Auth Token como llave, comparado en base64.
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function isValidTwilioSignature(authToken, url, params, signature) {
  if (!signature) return false;
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signature);
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const { TWILIO_AUTH_TOKEN, ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB } = process.env;
  if (!TWILIO_AUTH_TOKEN) {
    console.error("whatsapp-webhook: TWILIO_AUTH_TOKEN no configurada");
    res.status(500).end();
    return;
  }

  const params = req.body || {};
  const proto = req.headers["x-forwarded-proto"] || "https";
  const url = `${proto}://${req.headers.host}${req.url}`;
  const signature = req.headers["x-twilio-signature"];

  if (!isValidTwilioSignature(TWILIO_AUTH_TOKEN, url, params, signature)) {
    console.error("whatsapp-webhook: firma de Twilio inválida", { url, hasSignature: !!signature });
    res.status(403).end();
    return;
  }

  const from = params.From; // "whatsapp:+56912345678"
  const body = params.Body;
  if (!from || !body) {
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml("No recibí ningún mensaje de texto. ¿Puedes reenviarlo?"));
    return;
  }

  const telefono = from.replace(/^whatsapp:/, "");

  try {
    const result = await processMessage({
      telefono,
      mensaje: body,
      env: { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB },
    });
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml(result.reply));
  } catch (err) {
    console.error("whatsapp-webhook error:", err);
    res.setHeader("Content-Type", "text/xml");
    res.status(200).send(twiml("Tuve un problema técnico procesando tu mensaje. Intenta de nuevo en unos minutos."));
  }
}
