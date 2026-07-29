// api/whatsapp-webhook.js — Recibe mensajes entrantes de WhatsApp vía Twilio.
// Valida la firma de Twilio, responde de inmediato con un TwiML vacío (Claude puede
// tardar 15-20s, más de lo que Twilio espera por una respuesta síncrona), y una vez
// lista la respuesta la envía por separado vía la API de mensajes de Twilio.
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { processMessage } from "../lib/jacob-core.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const FALLBACK_MESSAGE = "Tuve un problema técnico procesando tu mensaje. Intenta de nuevo en unos minutos.";

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

// WhatsApp/Twilio rechaza mensajes de más de 1600 caracteres (error 21617). Las
// respuestas completas de Jacob (diagnóstico ESTADO 2 con las 4 secciones) suelen
// superarlo, así que se parten en varios mensajes respetando párrafos.
function splitForWhatsApp(text, maxLen = 1500) {
  if (text.length <= maxLen) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      if (para.length > maxLen) {
        for (let i = 0; i < para.length; i += maxLen) {
          chunks.push(para.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = para;
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendWhatsAppMessage(accountSid, authToken, to, from, body) {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Twilio send ${response.status}: ${errText}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const {
    TWILIO_AUTH_TOKEN,
    TWILIO_ACCOUNT_SID,
    TWILIO_WHATSAPP_NUMBER,
    ANTHROPIC_API_KEY,
    NOTION_TOKEN,
    NOTION_CLIENTES_DB,
    NOTION_ACCIONES_DB,
  } = process.env;

  if (!TWILIO_AUTH_TOKEN || !TWILIO_ACCOUNT_SID || !TWILIO_WHATSAPP_NUMBER) {
    console.error("whatsapp-webhook: faltan variables TWILIO_*");
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

  // Responder de inmediato para no dejar a Twilio esperando una respuesta síncrona
  // que puede tardar más de lo que Twilio está dispuesto a esperar. `waitUntil` le
  // dice explícitamente a Vercel que mantenga la función viva hasta que el trabajo de
  // abajo termine — sin esto, Vercel corta la ejecución apenas se manda la respuesta
  // (a diferencia de un servidor propio de toda la vida, donde el proceso sigue solo).
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(EMPTY_TWIML);

  if (!from || !body) {
    console.error("whatsapp-webhook: falta From o Body", params);
    return;
  }

  const telefono = from.replace(/^whatsapp:/, "");

  waitUntil(
    (async () => {
      try {
        const result = await processMessage({
          telefono,
          mensaje: body,
          env: { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB },
        });
        for (const chunk of splitForWhatsApp(result.reply)) {
          await sendWhatsAppMessage(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, from, TWILIO_WHATSAPP_NUMBER, chunk);
        }
      } catch (err) {
        console.error("whatsapp-webhook error:", err);
        try {
          await sendWhatsAppMessage(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, from, TWILIO_WHATSAPP_NUMBER, FALLBACK_MESSAGE);
        } catch (sendErr) {
          console.error("whatsapp-webhook: fallo enviando mensaje de fallback:", sendErr);
        }
      }
    })()
  );
}
