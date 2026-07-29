// api/jacob-agent.js — Endpoint conversacional directo (chat web / pruebas por API).
// La lógica de memoria (Notion) + Claude vive en lib/jacob-core.js, compartida con
// api/whatsapp-webhook.js.
import { processMessage } from "../lib/jacob-core.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { telefono, mensaje } = req.body || {};
  if (!telefono || !mensaje) {
    return res.status(400).json({ error: "Se requieren 'telefono' y 'mensaje'" });
  }

  try {
    const result = await processMessage({ telefono, mensaje, env: process.env });
    res.status(200).json(result);
  } catch (err) {
    console.error("jacob-agent error:", err);
    res.status(500).json({ error: "Failed to get a response from Jacob." });
  }
}
