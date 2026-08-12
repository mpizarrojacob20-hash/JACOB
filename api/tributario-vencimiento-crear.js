// api/tributario-vencimiento-crear.js — Registra una obligación tributaria con su fecha
// límite. Endpoint simple mientras no está conectado al flujo de chat.
import { findClientByPhone } from "../lib/jacob-core.js";
import { createVencimiento } from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_VENCIMIENTOS_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB || !NOTION_VENCIMIENTOS_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const { telefono, tipo, fechaLimite, etiqueta } = req.body || {};
  if (!telefono || !tipo || !fechaLimite) {
    res.status(400).json({ error: "Se requieren 'telefono', 'tipo' y 'fechaLimite' (YYYY-MM-DD)" });
    return;
  }

  try {
    const clientPage = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
    if (!clientPage) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }
    await createVencimiento(NOTION_TOKEN, NOTION_VENCIMIENTOS_DB, { clientPageId: clientPage.id, tipo, fechaLimite, etiqueta });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("tributario-vencimiento-crear error:", err);
    res.status(500).json({ error: err.message });
  }
}
