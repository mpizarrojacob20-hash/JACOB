// api/tributario-f22.js — Módulo tributario, función 4 (borrador de F22 / renta anual).
// Agrega ingresos/gastos/PPM desde DTE y CONCILIACION_MENSUAL; no calcula impuesto a
// pagar (depende del régimen tributario del cliente, no se adivina).
import { findClientByPhone } from "../lib/jacob-core.js";
import { draftF22 } from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_DTE_DB, NOTION_CONCILIACION_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_DTE_DB || !NOTION_CONCILIACION_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const { telefono, anio, retenciones, propuestaSiiBaseImponible } = req.body || {};
  if (!telefono || !anio) {
    res.status(400).json({ error: "Se requieren 'telefono' y 'anio' (YYYY)" });
    return;
  }

  try {
    const clientPage = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
    if (!clientPage) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }

    const resultado = await draftF22(NOTION_TOKEN, {
      dteDb: NOTION_DTE_DB,
      conciliacionDb: NOTION_CONCILIACION_DB,
      clientPageId: clientPage.id,
      anio,
      retenciones,
      propuestaSiiBaseImponible,
    });

    res.status(200).json(resultado);
  } catch (err) {
    console.error("tributario-f22 error:", err);
    res.status(500).json({ error: err.message });
  }
}
