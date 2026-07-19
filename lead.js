// api/lead.js — Guarda leads de la calculadora en Notion
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, recovered, valueRecovered, revenue, hours, ops } = req.body || {};

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido' });
  }

  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({
        parent: { database_id: process.env.NOTION_DB },
        properties: {
          'Name': {
            title: [{ text: { content: email } }]
          }
        },
        children: [
          {
            object: 'block',
            type: 'heading_2',
            heading_2: {
              rich_text: [{ text: { content: '📊 Lead de la calculadora' } }]
            }
          },
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{
                text: {
                  content:
                    `Email: ${email}\n` +
                    `Horas recuperables: ${recovered || '—'} h/semana\n` +
                    `Valor recuperable: $${valueRecovered ? Math.round(valueRecovered).toLocaleString() : '—'} USD/año\n` +
                    `Facturación anual: $${revenue ? Number(revenue).toLocaleString() : '—'} USD\n` +
                    `Horas trabajadas: ${hours || '—'} h/semana\n` +
                    `% operativo: ${ops || '—'}%\n` +
                    `Fecha: ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`
                }
              }]
            }
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Notion error:', err);
      return res.status(500).json({ error: 'Error guardando en Notion' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error del servidor' });
  }
}
