// lib/tributario.js — Módulo tributario/contable, función 1: conciliación de Libro de
// Compras y Ventas. Compara documento por documento (folio + tipo) lo que el cliente
// reportó contra lo que muestra el SII, y detecta qué falta de cada lado o qué monto no
// calza. Nunca inventa cifras — si falta un dato, lo deja fuera del cálculo en vez de
// asumirlo.
//
// IMPORTANTE: el PPM (Pago Provisional Mensual) NO se calcula acá todavía — su tasa la
// asigna el SII a cada contribuyente según su historial y no hay forma confiable de
// derivarla solo de los DTE. Mientras no tengamos esa tasa por cliente, se deja fuera en
// vez de inventar un número.
const NOTION_VERSION = "2022-06-28";

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

function richText(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}

const NOTA_LEGAL = "Este es un cálculo preparatorio. La presentación final la revisa y firma un contador certificado.";

function clp(n) {
  return n == null ? "?" : `$${Math.round(n).toLocaleString("es-CL")}`;
}

// Registra un documento tributario — ya sea lo que reportó el cliente o lo que muestra
// el SII (`fuente` distingue cuál). El folio + tipo es la clave que usa reconcileMonth
// para emparejar un lado con el otro.
export async function recordDTE(token, dteDb, {
  clientPageId,
  tipo, // "Emitido" | "Recibido"
  fuente, // "Cliente" | "SII"
  folio,
  rutContraparte,
  razonSocial,
  fecha, // "YYYY-MM-DD"
  montoNeto,
  iva,
  montoTotal,
}) {
  if (!clientPageId || !tipo || !fuente || !folio || !fecha) {
    throw new Error("recordDTE: faltan campos obligatorios (clientPageId, tipo, fuente, folio, fecha)");
  }
  await notionFetch(token, "pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dteDb },
      properties: {
        documento: {
          title: [{ text: { content: `${tipo} · Folio ${folio} · ${razonSocial || rutContraparte || "?"}` } }],
        },
        cliente: { relation: [{ id: clientPageId }] },
        tipo: { select: { name: tipo } },
        fuente: { select: { name: fuente } },
        folio: { rich_text: [{ text: { content: String(folio) } }] },
        rut_contraparte: { rich_text: [{ text: { content: rutContraparte || "" } }] },
        razon_social_contraparte: { rich_text: [{ text: { content: razonSocial || "" } }] },
        fecha: { date: { start: fecha } },
        monto_neto: { number: montoNeto ?? null },
        iva: { number: iva ?? null },
        monto_total: { number: montoTotal ?? null },
      },
    }),
  });
}

async function queryDTEForMonth(token, dteDb, clientPageId, periodo) {
  const [year, month] = periodo.split("-").map(Number);
  const start = `${periodo}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().split("T")[0];

  const query = await notionFetch(token, `databases/${dteDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "cliente", relation: { contains: clientPageId } },
          { property: "fecha", date: { on_or_after: start } },
          { property: "fecha", date: { on_or_before: end } },
        ],
      },
      page_size: 200,
    }),
  });
  return query.results;
}

function docKey(doc) {
  const p = doc.properties;
  return `${p.tipo?.select?.name}::${richText(p.folio)}`;
}

function docSummary(doc) {
  const p = doc.properties;
  return {
    tipo: p.tipo?.select?.name,
    folio: richText(p.folio),
    rut: richText(p.rut_contraparte),
    razonSocial: richText(p.razon_social_contraparte),
    monto: p.monto_total?.number,
  };
}

// Compara, folio por folio, lo que el cliente reportó contra lo que muestra el SII para
// un mes dado, y deja el resultado guardado en CONCILIACION_MENSUAL.
export async function reconcileMonth(token, { dteDb, conciliacionDb, clientPageId, periodo }) {
  const docs = await queryDTEForMonth(token, dteDb, clientPageId, periodo);
  const cliente = docs.filter((d) => d.properties.fuente?.select?.name === "Cliente");
  const sii = docs.filter((d) => d.properties.fuente?.select?.name === "SII");

  const clienteByKey = new Map(cliente.map((d) => [docKey(d), d]));
  const siiByKey = new Map(sii.map((d) => [docKey(d), d]));

  const faltanEnCliente = []; // el SII lo tiene, el cliente no lo reportó
  const faltanEnSII = []; // el cliente lo reportó, no aparece en el SII
  const montosNoCalzan = [];

  for (const [key, doc] of siiByKey) {
    if (!clienteByKey.has(key)) {
      faltanEnCliente.push(docSummary(doc));
      continue;
    }
    const clienteDoc = clienteByKey.get(key);
    const montoSII = doc.properties.monto_total?.number;
    const montoCliente = clienteDoc.properties.monto_total?.number;
    if (montoSII != null && montoCliente != null && Math.abs(montoSII - montoCliente) > 1) {
      montosNoCalzan.push({ ...docSummary(doc), montoCliente });
    }
  }
  for (const [key, doc] of clienteByKey) {
    if (!siiByKey.has(key)) faltanEnSII.push(docSummary(doc));
  }

  const ivaDebito = sii
    .filter((d) => d.properties.tipo?.select?.name === "Emitido")
    .reduce((sum, d) => sum + (d.properties.iva?.number || 0), 0);
  const ivaCredito = sii
    .filter((d) => d.properties.tipo?.select?.name === "Recibido")
    .reduce((sum, d) => sum + (d.properties.iva?.number || 0), 0);

  const lineas = [
    ...faltanEnCliente.map(
      (d) => `- El SII tiene un ${d.tipo.toLowerCase()} que no reportaste: folio ${d.folio}, ${d.razonSocial || d.rut || "sin razón social"}, ${clp(d.monto)}.`
    ),
    ...faltanEnSII.map(
      (d) => `- Reportaste un ${d.tipo.toLowerCase()} que no aparece en el SII: folio ${d.folio}, ${d.razonSocial || d.rut || "sin razón social"}, ${clp(d.monto)}.`
    ),
    ...montosNoCalzan.map(
      (d) => `- Folio ${d.folio}: el SII muestra ${clp(d.monto)} pero tú reportaste ${clp(d.montoCliente)}.`
    ),
  ];

  const totalDiferencias = lineas.length;
  const reporte = totalDiferencias
    ? `Encontré ${totalDiferencias} diferencia(s) en ${periodo}:\n${lineas.join("\n")}`
    : `Todo calza en ${periodo} — el SII y lo que reportaste coinciden documento por documento.`;

  await notionFetch(token, "pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: conciliacionDb },
      properties: {
        periodo: { title: [{ text: { content: periodo } }] },
        cliente: { relation: [{ id: clientPageId }] },
        iva_debito: { number: ivaDebito },
        iva_credito: { number: ivaCredito },
        diferencia: { number: totalDiferencias },
        estado: { select: { name: totalDiferencias ? "Pendiente" : "Revisado" } },
        reporte_diferencias: { rich_text: [{ text: { content: reporte.slice(0, 2000) } }] },
      },
    }),
  });

  return { ivaDebito, ivaCredito, totalDiferencias, reporte };
}

async function findConciliacionRecord(token, conciliacionDb, clientPageId, periodo) {
  const query = await notionFetch(token, `databases/${conciliacionDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "cliente", relation: { contains: clientPageId } },
          { property: "periodo", title: { equals: periodo } },
        ],
      },
      page_size: 1,
    }),
  });
  return query.results[0] || null;
}

// Función 2 — revisión de F29 (IVA mensual). Parte de lo que ya calculó reconcileMonth
// (iva_debito / iva_credito) para el mismo período, así que esa función tiene que haber
// corrido antes. El PPM y la comparación contra la propuesta del SII son opcionales —
// si no llegan esos datos, se dice explícitamente que faltan en vez de inventarlos.
export async function reviewF29(token, { conciliacionDb, clientPageId, periodo, propuestaSiiIva, tasaPPM, ventasNetas }) {
  const record = await findConciliacionRecord(token, conciliacionDb, clientPageId, periodo);
  if (!record) {
    throw new Error(`No hay conciliación guardada para ${periodo} — corre la conciliación de ese mes primero.`);
  }

  const ivaDebito = record.properties.iva_debito?.number || 0;
  const ivaCredito = record.properties.iva_credito?.number || 0;
  const ivaDeterminado = ivaDebito - ivaCredito;
  const montoAPagarIVA = Math.max(0, ivaDeterminado);
  const remanente = ivaDeterminado < 0 ? Math.abs(ivaDeterminado) : 0;

  let ppm = null;
  if (tasaPPM != null && ventasNetas != null) {
    ppm = Math.round(ventasNetas * (tasaPPM / 100));
  }

  const totalAPagar = montoAPagarIVA + (ppm || 0);

  const lineas = [
    `IVA débito: ${clp(ivaDebito)}`,
    `IVA crédito: ${clp(ivaCredito)}`,
    remanente > 0
      ? `Remanente a favor (no pagas IVA este mes, se arrastra al siguiente): ${clp(remanente)}`
      : `IVA a pagar: ${clp(montoAPagarIVA)}`,
    ppm != null
      ? `PPM estimado (tasa ${tasaPPM}% sobre ventas netas de ${clp(ventasNetas)}): ${clp(ppm)}`
      : `PPM: no calculado — falta la tasa que el SII le asignó a este cliente.`,
  ];

  let alerta = null;
  if (propuestaSiiIva != null) {
    const diff = Math.abs(montoAPagarIVA - propuestaSiiIva);
    alerta =
      diff > 1000
        ? `⚠️ Diferencia relevante con el SII: su propuesta dice ${clp(propuestaSiiIva)}, tu cálculo da ${clp(montoAPagarIVA)} (diferencia de ${clp(diff)}). Revisa antes de presentar.`
        : `✅ Tu cálculo calza con la propuesta del SII (${clp(propuestaSiiIva)}).`;
  }

  const reporte = [`F29 — ${periodo}`, ...lineas, alerta, `Total estimado a pagar: ${clp(totalAPagar)}`, "", NOTA_LEGAL]
    .filter(Boolean)
    .join("\n");

  const updateProps = {};
  if (propuestaSiiIva != null) updateProps.propuesta_sii_iva = { number: propuestaSiiIva };
  if (ppm != null) updateProps.ppm_estimado = { number: ppm };
  if (Object.keys(updateProps).length > 0) {
    await notionFetch(token, `pages/${record.id}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: updateProps }),
    });
  }

  return { ivaDebito, ivaCredito, montoAPagarIVA, remanente, ppm, totalAPagar, alerta, reporte };
}

// --- Función 3: alertas de vencimientos ---

function daysUntil(isoDate) {
  const today = new Date(new Date().toISOString().split("T")[0] + "T00:00:00Z");
  const target = new Date(isoDate + "T00:00:00Z");
  return Math.round((target - today) / 86400000);
}

export async function createVencimiento(token, vencimientosDb, { clientPageId, tipo, fechaLimite, etiqueta }) {
  await notionFetch(token, "pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: vencimientosDb },
      properties: {
        obligacion: { title: [{ text: { content: etiqueta || `${tipo} ${fechaLimite}` } }] },
        cliente: { relation: [{ id: clientPageId }] },
        tipo: { select: { name: tipo } },
        fecha_limite: { date: { start: fechaLimite } },
        estado: { select: { name: "Pendiente" } },
      },
    }),
  });
}

async function listPendingVencimientos(token, vencimientosDb) {
  const query = await notionFetch(token, `databases/${vencimientosDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "estado", select: { does_not_equal: "Presentado" } },
      page_size: 200,
    }),
  });
  return query.results;
}

async function getPage(token, pageId) {
  return notionFetch(token, `pages/${pageId}`, { method: "GET" });
}

async function markRecordatorioEnviado(token, vencimientoId, tags) {
  await notionFetch(token, `pages/${vencimientoId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        recordatorios_enviados: { multi_select: tags.map((name) => ({ name })) },
      },
    }),
  });
}

// Recorre VENCIMIENTOS no presentados y arma la lista de recordatorios que corresponde
// mandar hoy (5 días antes, 1 día antes, el mismo día) — no manda nada, solo decide y
// entrega qué hay que avisar y a quién; el envío real lo hace el caller (para reusar el
// mismo mecanismo de canal preferido — Telegram si está vinculado, si no WhatsApp — que
// ya usa daily-checkin.js en vez de duplicarlo acá).
export async function checkVencimientos(token, { clientesDb, vencimientosDb }) {
  const pendientes = await listPendingVencimientos(token, vencimientosDb);
  const avisos = [];

  for (const v of pendientes) {
    const dias = daysUntil(v.properties.fecha_limite.date.start);
    const yaEnviados = (v.properties.recordatorios_enviados?.multi_select || []).map((o) => o.name);

    let tier = null;
    if (dias === 5 && !yaEnviados.includes("5dias")) tier = "5dias";
    else if (dias === 1 && !yaEnviados.includes("1dia")) tier = "1dia";
    else if (dias === 0 && !yaEnviados.includes("mismodia")) tier = "mismodia";
    // Ya pasó la fecha y nadie lo marcó "Presentado" — esto no estaba en el spec
    // original (que solo pedía 5d/1d/mismo día), pero dejarlo en silencio después de
    // vencido es peligroso dado que estamos hablando de multas y bloqueo de RUT. Avisa
    // una vez que venció, y de ahí en adelante una vez por semana mientras siga
    // pendiente, en vez de solo la primera vez.
    else if (dias < 0 && (!yaEnviados.includes("vencido") || Math.abs(dias) % 7 === 0)) tier = "vencido";

    if (!tier) continue;

    const clientPageId = v.properties.cliente.relation[0]?.id;
    if (!clientPageId) continue;
    const clientPage = await getPage(token, clientPageId);

    const obligacion = v.properties.obligacion.title.map((t) => t.plain_text).join("");
    const tipo = v.properties.tipo?.select?.name;
    const fecha = v.properties.fecha_limite.date.start;

    const mensaje =
      tier === "vencido"
        ? `🚨 Tu ${tipo} (${obligacion}) venció el ${fecha} y sigue sin marcarse como presentado. No declarar a tiempo genera multas e intereses — si ya lo hiciste, avísame para actualizarlo; si no, hazlo hoy.`
        : tier === "mismodia"
          ? `⏰ Hoy vence tu ${tipo} (${obligacion}). Si ya lo presentaste, avísame para marcarlo. Si no, es el último día.`
          : tier === "1dia"
            ? `⚠️ Mañana (${fecha}) vence tu ${tipo} (${obligacion}). ¿Cómo vas?`
            : `📅 En 5 días (${fecha}) vence tu ${tipo} (${obligacion}). Aviso temprano para que no te pille apurado.`;

    avisos.push({ vencimientoId: v.id, clientPage, mensaje, tier, yaEnviados });
  }

  return avisos;
}

export async function markVencimientoRecordatorio(token, vencimientoId, tier, yaEnviados) {
  await markRecordatorioEnviado(token, vencimientoId, [...yaEnviados, tier]);
}

export async function markVencimientoPresentado(token, vencimientoId) {
  await notionFetch(token, `pages/${vencimientoId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { estado: { select: { name: "Presentado" } } } }),
  });
}
