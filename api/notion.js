export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TOKEN = process.env.NOTION_TOKEN;
  const DB = process.env.NOTION_DB;
  if (!TOKEN || !DB) return res.status(500).json({ error: 'Notion no configurado' });
  try {
    const { cliente, diagnostico, plan } = req.body;
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: DB },
        properties: {
          'Nombre': { title: [{ text: { content: cliente.empresa || 'Sin nombre' } }] },
          'Industria': { select: { name: cliente.industria || 'Otro' } },
          'Ciudad': { rich_text: [{ text: { content: cliente.ciudad || '' } }] },
          'Empleados': { number: parseInt(cliente.empleados) || 0 },
          'Ingresos USD': { number: parseInt(cliente.ingresos) || 0 },
          'Score': { number: parseInt(diagnostico.score) || 0 },
          'Horas recuperables': { number: parseInt(cliente.total) || 0 },
          'Estado': { select: { name: 'Nuevo' } },
          'Fecha': { date: { start: new Date().toISOString().split('T')[0] } }
        },
        children: [
          { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ text: { content: 'Diagnóstico — ' + cliente.empresa } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Score: ' + diagnostico.score + '/100 — ' + diagnostico.score_label } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: diagnostico.situacion || '' } }] } },
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Causas raíz identificadas' } }] } },
          ...(diagnostico.causas || []).map(c => ({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: c.mecanismo + ' — ' + c.nombre + ': ' + c.descripcion + ' (Costo: $' + c.costo_mes + ' USD/mes)' } }] }
          })),
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Plan de trabajo de Jacob' } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: plan || '' } }] } },
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: 'Costo de inacción' } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: '$' + Math.round(cliente.valAnual).toLocaleString() + ' USD / año' } }] } },
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ text: { content: '3 acciones NOW' } }] } },
          ...(diagnostico.acciones || []).map((a,i) => ({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: (i+1) + '. ' + a.t + ' — ' + a.d } }] }
          }))
        ]
      })
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
