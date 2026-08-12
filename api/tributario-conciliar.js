// api/tributario-conciliar.js — Módulo tributario, función 1 (conciliación). Recibe
// documentos (del cliente y/o del SII) para un período, los guarda en DTE, y corre la
// comparación folio por folio contra CONCILIACION_MENSUAL. Sin autenticación de firma
// todavía porque no se llama desde Twilio/Telegram — es un endpoint interno/de prueba
// hasta que se conecte al flujo de chat.
import { findClientByPhone } from "../lib/jacob-core.js";
import { recordDTE, reconcileMonth } from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_DTE_DB, NOTION_CONCILIACION_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_DTE_DB || !NOTION_CONCILIACION_DB) {
    res.status(500).json({ error: "Falta configuración de Notion (NOTION_DTE_DB / NOTION_CONCILIACION_DB)" });
    return;
  }

  const { telefono, periodo, documentos } = req.body || {};
  if (!telefono || !periodo) {
    res.status(400).json({ error: "Se requieren 'telefono' y 'periodo' (YYYY-MM)" });
    return;
  }

  try {
    const clientPage = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
    if (!clientPage) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }

    for (const doc of documentos || []) {
      await recordDTE(NOTION_TOKEN, NOTION_DTE_DB, { clientPageId: clientPage.id, ...doc });
    }

    const resultado = await reconcileMonth(NOTION_TOKEN, {
      dteDb: NOTION_DTE_DB,
      conciliacionDb: NOTION_CONCILIACION_DB,
      clientPageId: clientPage.id,
      periodo,
    });

    res.status(200).json(resultado);
  } catch (err) {
    console.error("tributario-conciliar error:", err);
    res.status(500).json({ error: err.message });
  }
}
