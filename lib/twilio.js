// lib/twilio.js — Helpers de Twilio compartidos entre api/whatsapp-webhook.js
// (respuestas) y api/daily-checkin.js (mensajes proactivos).

// WhatsApp/Twilio rechaza mensajes de más de 1600 caracteres (error 21617). Las
// respuestas completas de Jacob (diagnóstico ESTADO 2 con las 4 secciones) suelen
// superarlo, así que se parten en varios mensajes respetando párrafos.
export function splitForWhatsApp(text, maxLen = 1500) {
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

export async function sendWhatsAppMessage(accountSid, authToken, to, from, body) {
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

export async function sendWhatsAppMessageChunked(accountSid, authToken, to, from, text) {
  for (const chunk of splitForWhatsApp(text)) {
    await sendWhatsAppMessage(accountSid, authToken, to, from, chunk);
  }
}
