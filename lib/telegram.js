// lib/telegram.js — Helpers mínimos de la Bot API de Telegram para el MVP.
// A diferencia de WhatsApp, Telegram no exige plantillas pre-aprobadas para escribir
// primero, y el límite de largo por mensaje (4096) es generoso — no hace falta chunking
// para las respuestas típicas de Jacob.

// `opts.replyMarkup` para adjuntar un teclado; `opts.markdown` solo para textos propios
// y conocidos (el saludo) — las respuestas de Claude van sin parse_mode porque su texto
// dinámico puede traer caracteres que rompan el parser de Markdown de Telegram.
export async function sendTelegramMessage(botToken, chatId, text, opts = {}) {
  const body = { chat_id: chatId, text };
  if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
  if (opts.markdown) body.parse_mode = "Markdown";

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Telegram sendMessage ${response.status}: ${errText}`);
  }
}

// Teclado de respuesta rápida con prompts de ejemplo — tocarlo manda ese texto como si
// el cliente lo hubiera escrito, no requiere manejar callback_query por separado.
export const EXAMPLES_KEYBOARD = {
  keyboard: [
    ["Analiza mis números de este mes"],
    ["¿Qué margen es sano en mi rubro?"],
    ["Tengo una duda para clasificar un gasto"],
    ["Ayúdame a ordenar quién decide qué en mi equipo"],
  ],
  resize_keyboard: true,
  one_time_keyboard: true,
};
