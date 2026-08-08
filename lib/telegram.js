// lib/telegram.js — Helpers mínimos de la Bot API de Telegram para el MVP.
// A diferencia de WhatsApp, Telegram no exige plantillas pre-aprobadas para escribir
// primero, y el límite de largo por mensaje (4096) es generoso — no hace falta chunking
// para las respuestas típicas de Jacob.

export async function sendTelegramMessage(botToken, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram sendMessage ${response.status}: ${errText}`);
  }
}
