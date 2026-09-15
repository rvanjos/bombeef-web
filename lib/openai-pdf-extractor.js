'use strict';

function extractText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const parts = [];
  for (const item of (response?.output || [])) {
    for (const c of (item?.content || [])) {
      if (c?.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
      else if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function cleanJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  let start = -1;
  if (objStart >= 0 && arrStart >= 0) start = Math.min(objStart, arrStart);
  else start = Math.max(objStart, arrStart);
  if (start < 0) throw new Error('A OpenAI não retornou JSON válido');
  const opener = raw[start];
  const end = opener === '{' ? raw.lastIndexOf('}') : raw.lastIndexOf(']');
  if (end <= start) throw new Error('A OpenAI não retornou JSON completo');
  return JSON.parse(raw.slice(start, end + 1));
}

async function extractPdfJson(buffer, filename, prompt, options = {}) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY não configurada no servidor.');
    err.status = 503;
    throw err;
  }

  const model = String(process.env.OPENAI_PDF_MODEL || 'gpt-5.6-luna').trim();
  const base64 = Buffer.from(buffer).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 45000));

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: filename || 'documento.pdf',
              file_data: `data:application/pdf;base64,${base64}`,
            },
            { type: 'input_text', text: prompt },
          ],
        }],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || `Falha na OpenAI (${response.status})`;
      const err = new Error(msg);
      err.status = response.status;
      throw err;
    }

    return cleanJson(extractText(data));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { extractPdfJson, extractText, cleanJson };
