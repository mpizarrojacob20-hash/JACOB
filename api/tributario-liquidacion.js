// api/tributario-liquidacion.js — Módulo tributario, función 5 (liquidación de sueldo).
// Cálculo puro (AFP/salud/cesantía/impuesto único con la UTM del día vía mindicador.cl);
// no persiste en Notion todavía, devuelve el resultado y el texto listo para el
// trabajador.
import { findClientByPhone } from "../lib/jacob-core.js";
import { calcularLiquidacion, formatearLiquidacion } from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const { telefono, empleado, periodo, sueldoBase, bonos, otrosDescuentos, tasaAFP, contrato } = req.body || {};
  if (!telefono || !empleado || !periodo || sueldoBase == null) {
    res.status(400).json({ error: "Se requieren 'telefono', 'empleado', 'periodo' y 'sueldoBase'" });
    return;
  }

  try {
    const clientPage = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
    if (!clientPage) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }

    const resultado = await calcularLiquidacion({ sueldoBase, bonos, otrosDescuentos, tasaAFP, contrato });
    const texto = formatearLiquidacion({ empleado, periodo, sueldoBase, bonos }, resultado);

    res.status(200).json({ ...resultado, texto });
  } catch (err) {
    console.error("tributario-liquidacion error:", err);
    res.status(400).json({ error: err.message });
  }
}
