// api/tributario.js — Endpoint único para las acciones del módulo tributario que un
// cliente dispara (conciliación, F29, vencimientos, F22, liquidación). Consolidado en un
// solo archivo — Vercel Hobby limita a 12 funciones serverless por despliegue y con un
// archivo por función nos pasábamos. El cron de vencimientos sigue en su propio archivo
// (api/tributario-vencimientos-check.js) porque no encaja en este patrón de "una acción,
// un cliente" — recorre a todos.
import { findClientByPhone } from "../lib/jacob-core.js";
import {
  recordDTE,
  reconcileMonth,
  reviewF29,
  createVencimiento,
  draftF22,
  calcularLiquidacion,
  formatearLiquidacion,
} from "../lib/tributario.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { NOTION_TOKEN, NOTION_CLIENTES_DB, NOTION_DTE_DB, NOTION_CONCILIACION_DB, NOTION_VENCIMIENTOS_DB } = process.env;
  if (!NOTION_TOKEN || !NOTION_CLIENTES_DB) {
    res.status(500).json({ error: "Falta configuración de Notion" });
    return;
  }

  const { accion, telefono, ...params } = req.body || {};
  if (!accion || !telefono) {
    res.status(400).json({ error: "Se requieren 'accion' y 'telefono'" });
    return;
  }

  try {
    const clientPage = await findClientByPhone(NOTION_TOKEN, NOTION_CLIENTES_DB, telefono);
    if (!clientPage) {
      res.status(404).json({ error: "Cliente no encontrado" });
      return;
    }

    let resultado;

    switch (accion) {
      case "conciliar": {
        for (const doc of params.documentos || []) {
          await recordDTE(NOTION_TOKEN, NOTION_DTE_DB, { clientPageId: clientPage.id, ...doc });
        }
        resultado = await reconcileMonth(NOTION_TOKEN, {
          dteDb: NOTION_DTE_DB,
          conciliacionDb: NOTION_CONCILIACION_DB,
          clientPageId: clientPage.id,
          periodo: params.periodo,
        });
        break;
      }

      case "f29": {
        resultado = await reviewF29(NOTION_TOKEN, {
          conciliacionDb: NOTION_CONCILIACION_DB,
          clientPageId: clientPage.id,
          periodo: params.periodo,
          propuestaSiiIva: params.propuestaSiiIva,
          tasaPPM: params.tasaPPM,
          ventasNetas: params.ventasNetas,
        });
        break;
      }

      case "vencimiento_crear": {
        await createVencimiento(NOTION_TOKEN, NOTION_VENCIMIENTOS_DB, {
          clientPageId: clientPage.id,
          tipo: params.tipo,
          fechaLimite: params.fechaLimite,
          etiqueta: params.etiqueta,
        });
        resultado = { ok: true };
        break;
      }

      case "f22": {
        resultado = await draftF22(NOTION_TOKEN, {
          dteDb: NOTION_DTE_DB,
          conciliacionDb: NOTION_CONCILIACION_DB,
          clientPageId: clientPage.id,
          anio: params.anio,
          retenciones: params.retenciones,
          propuestaSiiBaseImponible: params.propuestaSiiBaseImponible,
        });
        break;
      }

      case "liquidacion": {
        const calc = await calcularLiquidacion({
          sueldoBase: params.sueldoBase,
          bonos: params.bonos,
          otrosDescuentos: params.otrosDescuentos,
          tasaAFP: params.tasaAFP,
          contrato: params.contrato,
        });
        resultado = {
          ...calc,
          texto: formatearLiquidacion(
            { empleado: params.empleado, periodo: params.periodo, sueldoBase: params.sueldoBase, bonos: params.bonos },
            calc
          ),
        };
        break;
      }

      default:
        res.status(400).json({ error: `Acción desconocida: ${accion}` });
        return;
    }

    res.status(200).json(resultado);
  } catch (err) {
    console.error(`tributario (${accion}) error:`, err);
    res.status(400).json({ error: err.message });
  }
}
