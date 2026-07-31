// lib/jacob-core.js — Lógica compartida entre api/jacob-agent.js (chat directo) y
// api/whatsapp-webhook.js (Twilio): memoria en Notion (CLIENTES + ACCIONES) + llamada
// a Claude. Sin SDK, sin dependencias — mismo estilo que notion.js/analyze.js.
import { JACOB_SYSTEM_PROMPT } from "../prompts/jacob-system-prompt.js";

const NOTION_VERSION = "2022-06-28";
const MODEL = "claude-opus-5";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function daysAgo(isoDate) {
  if (!isoDate) return null;
  const diffMs = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.round(diffMs / 86400000));
}

async function notionFetch(token, path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Notion ${path} ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Solo busca — no crea. El acceso a Jacob se controla teniendo (o no) un registro
// en CLIENTES: si un cliente le pasa el número a otra persona, esa persona no tiene
// fila ahí y queda bloqueada antes de gastar un solo token de Claude.
async function findClient(token, clientesDb, telefono) {
  const query = await notionFetch(token, `databases/${clientesDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "telefono", title: { equals: telefono } },
      page_size: 1,
    }),
  });
  return query.results[0] || null;
}

// Lista todos los clientes habilitados (una sola página, hasta 100 — suficiente para
// la base de clientes piloto; si crece más de eso hay que paginar).
export async function listAllClients(token, clientesDb) {
  const query = await notionFetch(token, `databases/${clientesDb}/query`, {
    method: "POST",
    body: JSON.stringify({ page_size: 100 }),
  });
  return query.results;
}

async function touchClientLastInteraction(token, clientPageId) {
  await notionFetch(token, `pages/${clientPageId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: { ultima_interaccion: { date: { start: todayISO() } } },
    }),
  });
}

async function getPendingActions(token, accionesDb, clientPageId) {
  const query = await notionFetch(token, `databases/${accionesDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "cliente", relation: { contains: clientPageId } },
          { property: "estado", select: { equals: "pendiente" } },
        ],
      },
      sorts: [{ property: "fecha", direction: "descending" }],
      page_size: 10,
    }),
  });
  return query.results;
}

function richText(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}

export function clientPhone(clientPage) {
  return titleText(clientPage.properties.telefono);
}

function titleText(prop) {
  return (prop?.title || []).map((t) => t.plain_text).join("");
}

function buildContextBlock(clientProfile, pendingActions) {
  const props = clientProfile.properties;
  const lines = ["[HISTORIAL DEL CLIENTE]"];

  const lastInteraction = props.ultima_interaccion?.date?.start;
  const daysSince = daysAgo(lastInteraction);
  lines.push(
    daysSince === null
      ? "Última conversación: sin registro previo."
      : `Última conversación: hace ${daysSince} día(s).`
  );

  const industria = props.industria?.select?.name;
  const tamano = props.tamaño_equipo?.number;
  if (industria) lines.push(`Industria: ${industria}${tamano ? `, equipo de ${tamano} personas` : ""}`);

  const flags = richText(props.flags_auditoria_abiertos);
  if (flags) lines.push(`Focos rojos de auditoría abiertos: ${flags}`);

  if (pendingActions.length === 0) {
    lines.push("Acciones pendientes: ninguna.");
  } else {
    lines.push("Acciones pendientes:");
    for (const action of pendingActions) {
      const p = action.properties;
      const accion = titleText(p.accion);
      const fecha = p.fecha?.date?.start;
      const metrica = richText(p.metrica_relacionada);
      const ago = daysAgo(fecha);
      lines.push(
        `- "${accion}" (dada hace ${ago ?? "?"} día(s)${metrica ? `, métrica relacionada: ${metrica}` : ""})`
      );
    }
  }

  return lines.join("\n");
}

async function anthropicMessage(apiKey, userContent) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: [
        { type: "text", text: JACOB_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}: ${JSON.stringify(data)}`);
  }
  const textBlock = data.content.find((b) => b.type === "text");
  return textBlock?.text ?? "";
}

async function callClaude(apiKey, contextBlock, mensaje) {
  return anthropicMessage(apiKey, `${contextBlock}\n\n[MENSAJE DEL CLIENTE]\n${mensaje}`);
}

async function callClaudeForDailyNudge(apiKey, contextBlock) {
  const instruction = `${contextBlock}

[INSTRUCCIÓN INTERNA — no es un mensaje del cliente, tú inicias esta conversación]
Son las 8am y le vas a escribir tú primero, sin que él te haya preguntado nada. Genera
un mensaje corto de WhatsApp para arrancar el día:
- Si tiene acciones pendientes, recuérdale la más relevante de forma natural y directa.
- Si no tiene ninguna pendiente, invítalo a compartir números nuevos o resolver una duda
  puntual de gestión.
Máximo 3-4 líneas. Tono cercano, como un socio que se preocupa por cómo le va — NO como
una notificación automática. No uses el formato de diagnóstico ESTADO 2 (nada de
"1. Estado del negocio... 2. El problema..."), esto es solo un saludo con gancho.`;
  return anthropicMessage(apiKey, instruction);
}

// Extrae, de forma best-effort, las 3 acciones numeradas del formato ESTADO 2.
// El modelo no devuelve un formato estructurado — esto es una heurística sobre
// markdown (listas "1. 2. 3."), no un parser garantizado.
function extractActions(replyText) {
  const matches = [...replyText.matchAll(/^\s*\d+\.\s*(.+)$/gm)]
    .map((m) => m[1].replace(/\*\*/g, "").trim())
    .filter((line) => line.length > 15);
  return matches.slice(0, 3);
}

async function createActionRecords(token, accionesDb, clientPageId, actions) {
  for (const accion of actions) {
    await notionFetch(token, "pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: accionesDb },
        properties: {
          cliente: { relation: [{ id: clientPageId }] },
          fecha: { date: { start: todayISO() } },
          accion: { title: [{ text: { content: accion } }] },
          estado: { select: { name: "pendiente" } },
        },
      }),
    });
  }
}

export async function processMessage({ telefono, mensaje, env }) {
  const { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_ACCIONES_DB } = env;
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurada");
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_ACCIONES_DB) {
    throw new Error("Notion no configurado (NOTION_TOKEN / NOTION_CLIENTES_DB / NOTION_ACCIONES_DB)");
  }

  const clientPage = await findClient(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
  if (!clientPage) {
    return {
      reply: "Este número no está habilitado para hablar con Jacob. Si eres cliente, pide que te activen el acceso.",
      autorizado: false,
      acciones_creadas: [],
    };
  }

  const pendingActions = await getPendingActions(NOTION_TOKEN, NOTION_ACCIONES_DB, clientPage.id);
  const contextBlock = buildContextBlock(clientPage, pendingActions);

  const reply = await callClaude(ANTHROPIC_API_KEY, contextBlock, mensaje);

  // Solo se generan acciones nuevas cuando el cliente comparte números reales en su
  // mensaje — el mismo gatillo que el system prompt usa para el formato ESTADO 2. Sin
  // este filtro, un mensaje de seguimiento donde Jacob recapitula las acciones
  // pendientes (también en formato numerado) las duplicaba como si fueran nuevas.
  const clientSharedNumbers = /\d/.test(mensaje);
  const newActions = clientSharedNumbers ? extractActions(reply) : [];
  if (newActions.length === 3) {
    await createActionRecords(NOTION_TOKEN, NOTION_ACCIONES_DB, clientPage.id, newActions);
  }

  await touchClientLastInteraction(NOTION_TOKEN, clientPage.id);

  return {
    reply,
    autorizado: true,
    acciones_creadas: newActions.length === 3 ? newActions : [],
  };
}

// Genera el saludo proactivo de las 8am para un cliente puntual (usado por
// api/daily-checkin.js). A diferencia de processMessage, Jacob inicia la
// conversación — no hay "mensaje del cliente" que responder.
export async function generateDailyNudge({ clientPage, env }) {
  const { ANTHROPIC_API_KEY, NOTION_TOKEN, NOTION_ACCIONES_DB } = env;
  const pendingActions = await getPendingActions(NOTION_TOKEN, NOTION_ACCIONES_DB, clientPage.id);
  const contextBlock = buildContextBlock(clientPage, pendingActions);
  return callClaudeForDailyNudge(ANTHROPIC_API_KEY, contextBlock);
}
