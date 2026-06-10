const express = require('express')
const cors = require('cors')
const multer = require('multer')
const { Mistral } = require('@mistralai/mistralai')

const app = express()
const PORT = process.env.PORT || 3001

// ─── CORS ──────────────────────────────────────────────────────────────────
// Allow all origins (Vercel frontend URL will call this)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json())

// ─── Multer (in-memory file storage) ───────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file
})

// ─── Mistral Client ─────────────────────────────────────────────────────────
function getMistralClient() {
  const apiKey = process.env.MISTRAL_API_KEY
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY environment variable is not set')
  }
  return new Mistral({ apiKey })
}

// ─── Helper: Generate ID ────────────────────────────────────────────────────
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2)
}

// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Invoice Extraction API (Mistral AI) is running' })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Main Extract Route ─────────────────────────────────────────────────────
app.post('/api/extract', upload.array('files', 20), async (req, res) => {
  try {
    const prompt = req.body.prompt
    const files = req.files || []

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: 'Prompt is required. Please describe what you want to extract.',
      })
    }

    console.log(`[Extract] Prompt: "${prompt.substring(0, 80)}..."`)
    console.log(`[Extract] Files received: ${files.length}`)

    const extractionId = generateId()

    // ── No files → return demo data ─────────────────────────────────────────
    if (files.length === 0) {
      const demoColumns = ['INVOICE #', 'DATE', 'VENDOR', 'AMOUNT', 'TAX', 'TOTAL', 'SOURCE FILE']
      const demoData = [
        { 'INVOICE #': 'INV-2025-001', DATE: '03/15/2025', VENDOR: 'Acme Corp', AMOUNT: '₹1,250.00', TAX: '₹125.00', TOTAL: '₹1,375.00', 'SOURCE FILE': 'demo_invoice.pdf' },
        { 'INVOICE #': 'INV-2025-002', DATE: '03/16/2025', VENDOR: 'Tech Solutions', AMOUNT: '₹3,500.00', TAX: '₹350.00', TOTAL: '₹3,850.00', 'SOURCE FILE': 'demo_invoice.pdf' },
        { 'INVOICE #': 'INV-2025-003', DATE: '03/17/2025', VENDOR: 'Office Direct', AMOUNT: '₹890.00', TAX: '₹89.00', TOTAL: '₹979.00', 'SOURCE FILE': 'demo_invoice.pdf' },
      ]
      return res.json({ id: extractionId, status: 'completed', columns: demoColumns, data: demoData })
    }

    // ── Process each file with Mistral Vision ────────────────────────────────
    const client = getMistralClient()
    let allExtractedData = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      console.log(`[Extract] Processing ${i + 1}/${files.length}: ${file.originalname} (${file.mimetype}, ${file.size} bytes)`)

      const base64Data = file.buffer.toString('base64')
      const mimeType = file.mimetype || (file.originalname.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png')

      const extractionPrompt = `You are an expert invoice and document data extraction AI.

USER INSTRUCTIONS: ${prompt}

CRITICAL RULES:
1. Extract ONLY data that is actually visible in the document. Do NOT make up or hallucinate data.
2. If a field is not found in the document, use an empty string "" for that field.
3. Return the result as a JSON array of objects. Each object = one row of data.
4. For invoices: one row per invoice found.
5. For line items: one row per line item.
6. Be precise with numbers - include currency symbols exactly as shown in the document.
7. Dates should be in the format they appear in the document.
8. Always include a "SOURCE FILE" field with the value: "${file.originalname}"

RESPONSE FORMAT - Return ONLY a valid JSON array. No markdown, no explanation, just the JSON:
[
  {
    "FIELD_NAME": "extracted value",
    "SOURCE FILE": "${file.originalname}"
  }
]`

      try {
        // Build message content for Mistral
        // Mistral pixtral-large supports base64 image and PDF
        let contentParts = [{ type: 'text', text: extractionPrompt }]

        if (mimeType === 'application/pdf') {
          // Mistral supports PDF as document_url with base64
          contentParts.push({
            type: 'document_url',
            documentUrl: `data:application/pdf;base64,${base64Data}`,
          })
        } else if (mimeType.startsWith('image/')) {
          contentParts.push({
            type: 'image_url',
            imageUrl: `data:${mimeType};base64,${base64Data}`,
          })
        }

        console.log(`[Extract] Calling Mistral pixtral-large for ${file.originalname}...`)

        const response = await client.chat.complete({
          model: 'pixtral-large-latest', // Best Mistral vision model
          messages: [{ role: 'user', content: contentParts }],
          temperature: 0.1,
          maxTokens: 8192,
        })

        const rawContent = response.choices?.[0]?.message?.content || ''
        console.log(`[Extract] Mistral response length: ${rawContent.length} chars`)
        console.log(`[Extract] Preview: ${rawContent.substring(0, 200)}...`)

        // Parse JSON from response
        let extractedRows = []
        try {
          const jsonMatch = rawContent.match(/\[[\s\S]*\]/)
          if (jsonMatch) {
            extractedRows = JSON.parse(jsonMatch[0])
          }
        } catch (parseErr) {
          console.error(`[Extract] JSON parse failed for ${file.originalname}:`, parseErr.message)

          // Fallback: ask Mistral to re-structure the output as JSON
          try {
            const fallbackResponse = await client.chat.complete({
              model: 'mistral-large-latest',
              messages: [
                {
                  role: 'system',
                  content: 'You are a data structuring assistant. Convert text into valid JSON array of objects. Return ONLY the JSON array, no markdown, no explanation.',
                },
                {
                  role: 'user',
                  content: `Convert this extracted text into a JSON array based on: "${prompt}"\nSource file: ${file.originalname}\n\nText:\n${rawContent}\n\nEach object must have "SOURCE FILE": "${file.originalname}"`,
                },
              ],
              temperature: 0.1,
              maxTokens: 4096,
            })

            const fallbackContent = fallbackResponse.choices?.[0]?.message?.content || ''
            const fallbackMatch = fallbackContent.match(/\[[\s\S]*\]/)
            if (fallbackMatch) {
              extractedRows = JSON.parse(fallbackMatch[0])
            }
          } catch (fallbackErr) {
            console.error(`[Extract] Fallback also failed for ${file.originalname}:`, fallbackErr.message)
          }
        }

        // Ensure SOURCE FILE field
        extractedRows = extractedRows.map(row => ({
          ...row,
          'SOURCE FILE': row['SOURCE FILE'] || file.originalname,
        }))

        console.log(`[Extract] Extracted ${extractedRows.length} rows from ${file.originalname}`)
        allExtractedData = [...allExtractedData, ...extractedRows]

      } catch (fileErr) {
        console.error(`[Extract] Error processing ${file.originalname}:`, fileErr.message)
        // Continue with other files instead of failing entirely
      }
    }

    // ── No data extracted ────────────────────────────────────────────────────
    if (allExtractedData.length === 0) {
      return res.json({
        id: extractionId,
        status: 'completed',
        columns: ['INFO', 'PROMPT USED', 'SOURCE FILE'],
        data: [{
          INFO: 'No data could be extracted. The documents may not contain the requested data, or files could not be read properly.',
          'PROMPT USED': prompt,
          'SOURCE FILE': files.map(f => f.originalname).join(', '),
        }],
      })
    }

    // ── Build column list ────────────────────────────────────────────────────
    const columnSet = new Set()
    allExtractedData.forEach(row => Object.keys(row).forEach(k => columnSet.add(k)))
    const columns = Array.from(columnSet).filter(c => c !== 'SOURCE FILE')
    if (columnSet.has('SOURCE FILE')) columns.push('SOURCE FILE')

    console.log(`[Extract] Done: ${allExtractedData.length} rows, ${columns.length} columns`)

    return res.json({
      id: extractionId,
      status: 'completed',
      columns,
      data: allExtractedData,
    })

  } catch (error) {
    console.error('[Extract] Unhandled error:', error?.message || error)
    return res.status(500).json({
      error: `Extraction failed: ${error?.message || 'Unknown error'}`,
    })
  }
})

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Invoice API Server running on port ${PORT}`)
  console.log(`Mistral API Key: ${process.env.MISTRAL_API_KEY ? '✓ Set' : '✗ NOT SET - set MISTRAL_API_KEY env var'}`)
})
