// api/tributario-f29.js — Módulo tributario, función 2 (revisión de F29). Requiere que
// la conciliación de ese período ya haya corrido (usa su iva_debito/iva_credito).
import { findClientByPhone } from "../lib/jacob-core.js";
import { reviewF29 } from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_CONCILIACION_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_CONCILIACION_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const { telefono, periodo, propuestaSiiIva, tasaPPM, ventasNetas } = req.body || {};
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

    const resultado = await reviewF29(NOTION_TOKEN, {
      conciliacionDb: NOTION_CONCILIACION_DB,
      clientPageId: clientPage.id,
      periodo,
      propuestaSiiIva,
      tasaPPM,
      ventasNetas,
    });

    res.status(200).json(resultado);
  } catch (err) {
    console.error("tributario-f29 error:", err);
    res.status(500).json({ error: err.message });
  }
}
