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

// --- Función 4: borrador de F22 (renta anual) ---
//
// A propósito NO calcula un impuesto final a pagar: el F22 real depende del régimen
// tributario del cliente (Pro Pyme, régimen general semi-integrado, etc.), cada uno con
// reglas y tasas distintas, y adivinar cuál aplica sería inventar. Esta función junta y
// suma lo que sí se puede sacar de datos reales — ingresos, gastos, PPM pagado — como
// insumo para que el contador certificado arme la declaración real.

async function queryDTEForYear(token, dteDb, clientPageId, anio) {
  const query = await notionFetch(token, `databases/${dteDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "cliente", relation: { contains: clientPageId } },
          { property: "fuente", select: { equals: "SII" } },
          { property: "fecha", date: { on_or_after: `${anio}-01-01` } },
          { property: "fecha", date: { on_or_before: `${anio}-12-31` } },
        ],
      },
      page_size: 500,
    }),
  });
  return query.results;
}

async function queryConciliacionesForYear(token, conciliacionDb, clientPageId, anio) {
  const query = await notionFetch(token, `databases/${conciliacionDb}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        and: [
          { property: "cliente", relation: { contains: clientPageId } },
          { property: "periodo", title: { starts_with: `${anio}-` } },
        ],
      },
      page_size: 12,
    }),
  });
  return query.results;
}

export async function draftF22(token, { dteDb, conciliacionDb, clientPageId, anio, retenciones, propuestaSiiBaseImponible }) {
  const docsAnio = await queryDTEForYear(token, dteDb, clientPageId, anio);
  const ingresos = docsAnio
    .filter((d) => d.properties.tipo?.select?.name === "Emitido")
    .reduce((sum, d) => sum + (d.properties.monto_neto?.number || 0), 0);
  const gastos = docsAnio
    .filter((d) => d.properties.tipo?.select?.name === "Recibido")
    .reduce((sum, d) => sum + (d.properties.monto_neto?.number || 0), 0);

  const conciliacionesAnio = await queryConciliacionesForYear(token, conciliacionDb, clientPageId, anio);
  const mesesConPPM = conciliacionesAnio.filter((c) => c.properties.ppm_estimado?.number != null);
  const ppmPagado = mesesConPPM.reduce((sum, c) => sum + (c.properties.ppm_estimado.number || 0), 0);

  const baseImponible = ingresos - gastos;

  const lineas = [
    `Ingresos del año (según DTE emitidos en el SII): ${clp(ingresos)}`,
    `Gastos del año (según DTE recibidos en el SII): ${clp(gastos)}`,
    `Base imponible estimada (ingresos − gastos): ${clp(baseImponible)}`,
    `PPM pagado durante el año: ${clp(ppmPagado)}${mesesConPPM.length < 12 ? ` (solo hay registro de ${mesesConPPM.length}/12 meses — pídele al cliente los meses que faltan)` : ""}`,
    retenciones != null ? `Retenciones: ${clp(retenciones)}` : `Retenciones: no reportadas — pídeselas al cliente, no se pueden derivar de los DTE.`,
  ];

  let alerta = null;
  if (propuestaSiiBaseImponible != null) {
    const diff = Math.abs(baseImponible - propuestaSiiBaseImponible);
    alerta =
      diff > 10000
        ? `⚠️ La base imponible que propone el SII (${clp(propuestaSiiBaseImponible)}) no calza con lo calculado acá (${clp(baseImponible)}) — diferencia de ${clp(diff)}. Revísalo con el contador antes de presentar.`
        : `✅ La base imponible calza con la propuesta del SII (${clp(propuestaSiiBaseImponible)}).`;
  }

  const reporte = [
    `Borrador F22 — año ${anio}`,
    ...lineas,
    alerta,
    "",
    "Esto NO es un cálculo de impuesto a pagar — el F22 real depende del régimen tributario del cliente (Pro Pyme, general, etc.), que no se adivina acá.",
    NOTA_LEGAL,
  ]
    .filter(Boolean)
    .join("\n");

  return { ingresos, gastos, baseImponible, ppmPagado, mesesConPPM: mesesConPPM.length, retenciones: retenciones ?? null, alerta, reporte };
}

// --- Función 5: liquidaciones de sueldo ---
//
// Tabla de Impuesto Único de Segunda Categoría — tramos en UTM, factor y rebaja en UTM.
// Verificada contra la tabla vigente en agosto 2026. El SII la reajusta cada mes (según
// la UTM) pero la ESTRUCTURA de tramos/factores/rebajas rara vez cambia — si el SII la
// actualiza, este es el único lugar que hay que tocar.
export const TABLA_IMPUESTO_UNICO = [
  { hastaUTM: 13.5, factor: 0, rebajaUTM: 0 },
  { hastaUTM: 30, factor: 0.04, rebajaUTM: 0.54 },
  { hastaUTM: 50, factor: 0.08, rebajaUTM: 1.74 },
  { hastaUTM: 70, factor: 0.135, rebajaUTM: 4.49 },
  { hastaUTM: 90, factor: 0.23, rebajaUTM: 11.14 },
  { hastaUTM: 120, factor: 0.304, rebajaUTM: 17.8 },
  { hastaUTM: 310, factor: 0.35, rebajaUTM: 23.32 },
  { hastaUTM: Infinity, factor: 0.4, rebajaUTM: 38.82 },
];

// Tasas previsionales configurables. tasaAFP NO tiene default a propósito — la comisión
// varía por administradora (0.46% Uno a 1.45% Provida en 2026, sobre el 10% obligatorio)
// y asumir una sería inventar un descuento real del sueldo de alguien. salud y AFC sí
// tienen default porque son mínimos legales parejos para todos (salvo que el trabajador
// tenga un plan Isapre pactado por sobre el mínimo, en cuyo caso hay que pasarlo).
export const TASAS_PREVISIONALES_DEFAULT = {
  salud: 0.07,
  afcTrabajadorIndefinido: 0.006,
  afcEmpleadorIndefinido: 0.024,
  afcEmpleadorPlazoFijo: 0.03,
};

async function getUTMVigente() {
  const resp = await fetch("https://mindicador.cl/api/utm");
  if (!resp.ok) throw new Error(`No se pudo obtener la UTM vigente (mindicador.cl respondió ${resp.status})`);
  const data = await resp.json();
  return data.serie[0].valor;
}

function calcularImpuestoUnico(baseTributable, utm) {
  if (baseTributable <= 0) return 0;
  const baseUTM = baseTributable / utm;
  const tramo = TABLA_IMPUESTO_UNICO.find((t) => baseUTM <= t.hastaUTM);
  const impuesto = baseTributable * tramo.factor - tramo.rebajaUTM * utm;
  return Math.max(0, Math.round(impuesto));
}

// tasaAFP es obligatoria — no se inventa un promedio. Todo lo demás tiene default legal
// pero se puede pisar.
export async function calcularLiquidacion({ sueldoBase, bonos = 0, otrosDescuentos = 0, tasaAFP, contrato = "indefinido", tasas = {} }) {
  if (tasaAFP == null) {
    throw new Error(
      "Falta 'tasaAFP' (10% obligatorio + comisión de la AFP del trabajador, que varía entre ~0.46% y ~1.45% según la administradora en 2026). Pregúntale al cliente qué AFP usa cada trabajador."
    );
  }
  if (sueldoBase == null) throw new Error("Falta 'sueldoBase'");

  const t = { ...TASAS_PREVISIONALES_DEFAULT, ...tasas };
  const utm = await getUTMVigente();

  const totalImponible = sueldoBase + bonos;
  const afp = Math.round(totalImponible * tasaAFP);
  const salud = Math.round(totalImponible * t.salud);
  const afcTrabajador = contrato === "indefinido" ? Math.round(totalImponible * t.afcTrabajadorIndefinido) : 0;

  const baseTributable = totalImponible - afp - salud - afcTrabajador;
  const impuestoUnico = calcularImpuestoUnico(baseTributable, utm);

  const totalDescuentos = afp + salud + afcTrabajador + impuestoUnico + otrosDescuentos;
  const liquido = totalImponible - totalDescuentos;

  return {
    totalImponible,
    afp,
    salud,
    afcTrabajador,
    impuestoUnico,
    otrosDescuentos,
    totalDescuentos,
    liquido,
    utmUsada: utm,
    tasaAFPUsada: tasaAFP,
  };
}

export function formatearLiquidacion({ empleado, periodo, sueldoBase, bonos = 0 }, resultado) {
  return [
    `LIQUIDACIÓN DE SUELDO — ${empleado} — ${periodo}`,
    "",
    `Sueldo base: ${clp(sueldoBase)}`,
    bonos ? `Bonos: ${clp(bonos)}` : null,
    `Total imponible: ${clp(resultado.totalImponible)}`,
    "",
    "Descuentos:",
    `- AFP (tasa ${(resultado.tasaAFPUsada * 100).toFixed(2)}%): ${clp(resultado.afp)}`,
    `- Salud: ${clp(resultado.salud)}`,
    resultado.afcTrabajador ? `- Seguro de cesantía: ${clp(resultado.afcTrabajador)}` : null,
    resultado.impuestoUnico ? `- Impuesto único: ${clp(resultado.impuestoUnico)}` : null,
    resultado.otrosDescuentos ? `- Otros descuentos: ${clp(resultado.otrosDescuentos)}` : null,
    `Total descuentos: ${clp(resultado.totalDescuentos)}`,
    "",
    `LÍQUIDO A PAGAR: ${clp(resultado.liquido)}`,
    `(UTM usada para el cálculo: ${clp(resultado.utmUsada)})`,
    "",
    NOTA_LEGAL,
  ]
    .filter(Boolean)
    .join("\n");
}

// --- Herramientas (tool use) para que Claude use el módulo tributario en conversación ---
// El clientPageId nunca lo llena Claude — lo agrega processMessage antes de ejecutar,
// así no hay forma de que un cliente termine tocando datos de otro por un error del
// modelo.

export const TRIBUTARIO_TOOLS = [
  {
    name: "conciliar_libro_compras_ventas",
    description:
      "Concilia documentos tributarios (DTE) que el cliente reportó contra lo que muestra el SII para un mes, detectando diferencias folio por folio. Úsala cuando el cliente te dé documentos (boletas/facturas) para revisar, o pida conciliar/revisar su IVA de compras y ventas.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", description: "Mes a conciliar, formato YYYY-MM" },
        documentos: {
          type: "array",
          description: "Documentos a registrar antes de conciliar (omite si ya se registraron en un mensaje anterior)",
          items: {
            type: "object",
            properties: {
              tipo: { type: "string", enum: ["Emitido", "Recibido"] },
              fuente: { type: "string", enum: ["Cliente", "SII"] },
              folio: { type: "string" },
              rutContraparte: { type: "string" },
              razonSocial: { type: "string" },
              fecha: { type: "string", description: "YYYY-MM-DD" },
              montoNeto: { type: "number" },
              iva: { type: "number" },
              montoTotal: { type: "number" },
            },
            required: ["tipo", "fuente", "folio", "fecha"],
          },
        },
      },
      required: ["periodo"],
    },
  },
  {
    name: "revisar_f29",
    description:
      "Revisa el F29 (IVA mensual) de un período ya conciliado: calcula el IVA a pagar, el PPM si se le da la tasa, y compara contra la propuesta del SII si el cliente la tiene. Requiere haber conciliado ese mes antes con conciliar_libro_compras_ventas.",
    input_schema: {
      type: "object",
      properties: {
        periodo: { type: "string", description: "YYYY-MM" },
        propuestaSiiIva: { type: "number", description: "Monto que propone el SII, si el cliente lo tiene" },
        tasaPPM: { type: "number", description: "Tasa de PPM del cliente en porcentaje (ej. 0.25), si la sabe" },
        ventasNetas: { type: "number", description: "Ventas netas del mes — necesario junto con tasaPPM para calcular el PPM" },
      },
      required: ["periodo"],
    },
  },
  {
    name: "crear_vencimiento",
    description:
      "Registra una obligación tributaria con su fecha límite para que el sistema le avise al cliente automáticamente más adelante (5 días antes, 1 día antes, el mismo día, y si queda vencida).",
    input_schema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: ["F29", "F22", "Previred", "Otro"] },
        fechaLimite: { type: "string", description: "YYYY-MM-DD" },
        etiqueta: { type: "string", description: "Descripción corta, ej. 'F29 Agosto 2026'" },
      },
      required: ["tipo", "fechaLimite"],
    },
  },
  {
    name: "borrador_f22",
    description:
      "Arma un borrador de renta anual (F22): suma ingresos, gastos y PPM pagado del año a partir de los datos ya registrados. NO calcula el impuesto final a pagar — eso depende del régimen tributario del cliente, que define el contador.",
    input_schema: {
      type: "object",
      properties: {
        anio: { type: "integer", description: "Año a revisar, ej. 2026" },
        retenciones: { type: "number", description: "Retenciones del año, si el cliente las tiene — no se pueden derivar de los DTE" },
        propuestaSiiBaseImponible: { type: "number" },
      },
      required: ["anio"],
    },
  },
  {
    name: "calcular_liquidacion_sueldo",
    description:
      "Calcula la liquidación de sueldo de un trabajador (AFP, salud, seguro de cesantía, impuesto único, líquido a pagar) con la UTM vigente del día. La tasa de AFP varía según la administradora del trabajador — pregúntasela al cliente si no la tienes, nunca la asumas.",
    input_schema: {
      type: "object",
      properties: {
        empleado: { type: "string" },
        periodo: { type: "string", description: "YYYY-MM" },
        sueldoBase: { type: "number" },
        bonos: { type: "number" },
        otrosDescuentos: { type: "number" },
        tasaAFP: { type: "number", description: "Tasa AFP como decimal, ej. 0.1145 para 11.45%. Obligatoria." },
        contrato: { type: "string", enum: ["indefinido", "plazo_fijo"] },
      },
      required: ["empleado", "periodo", "sueldoBase", "tasaAFP"],
    },
  },
];

export async function executeTributarioTool(name, input, { clientPageId, env }) {
  const { NOTION_TOKEN, NOTION_DTE_DB, NOTION_CONCILIACION_DB, NOTION_VENCIMIENTOS_DB } = env;

  switch (name) {
    case "conciliar_libro_compras_ventas": {
      for (const doc of input.documentos || []) {
        await recordDTE(NOTION_TOKEN, NOTION_DTE_DB, { clientPageId, ...doc });
      }
      return await reconcileMonth(NOTION_TOKEN, {
        dteDb: NOTION_DTE_DB,
        conciliacionDb: NOTION_CONCILIACION_DB,
        clientPageId,
        periodo: input.periodo,
      });
    }
    case "revisar_f29":
      return await reviewF29(NOTION_TOKEN, { conciliacionDb: NOTION_CONCILIACION_DB, clientPageId, ...input });
    case "crear_vencimiento":
      await createVencimiento(NOTION_TOKEN, NOTION_VENCIMIENTOS_DB, { clientPageId, ...input });
      return { ok: true };
    case "borrador_f22":
      return await draftF22(NOTION_TOKEN, {
        dteDb: NOTION_DTE_DB,
        conciliacionDb: NOTION_CONCILIACION_DB,
        clientPageId,
        ...input,
      });
    case "calcular_liquidacion_sueldo": {
      const calc = await calcularLiquidacion(input);
      return { ...calc, texto: formatearLiquidacion(input, calc) };
    }
    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}
