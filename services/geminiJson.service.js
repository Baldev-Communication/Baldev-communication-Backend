const crypto = require('node:crypto');

// These aliases follow supported Flash models when a version is retired.
// Keep the administrator's configured model first; never change their .env.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const CACHE_MS = 15 * 60 * 1000;
let modelCache;

function aiError(contextCode, message, retryModel = false) {
  return Object.assign(new Error(message), { contextCode, retryModel });
}

function cacheFor(key, configured) {
  const identity = crypto.createHash('sha256').update(key + '\0' + configured).digest('hex');
  if (modelCache?.identity !== identity || modelCache.expiresAt <= Date.now()) {
    modelCache = { identity, expiresAt: Date.now() + CACHE_MS, unavailable: new Set(), preferred: '' };
  }
  return modelCache;
}

function providerError(status, payload) {
  const detail = String(payload?.error?.message || '');
  if (status === 400 && /(?:google.?search|grounding|search tool).{0,100}(?:not supported|unsupported|unavailable)|(?:not supported|unsupported).{0,100}(?:google.?search|grounding|search tool)/i.test(detail)) {
    return aiError('AI_SEARCH_UNSUPPORTED', 'The configured Gemini models do not support Google Search grounding.', true);
  }
  if (status === 404 || status === 410 || status === 400 && /model.*(?:not found|not supported|unavailable|retired)/i.test(detail)) {
    return aiError('AI_MODEL_UNAVAILABLE', 'The configured AI model and available fallbacks could not be used. Check the Gemini model available to your project.', true);
  }
  if (status === 429) return aiError('AI_QUOTA_EXCEEDED', 'The Gemini quota is currently exhausted. Check the API project billing and usage limits, or wait for the limit to reset.');
  if ([400, 401, 403].includes(status) && /reported.{0,20}leaked|leaked.{0,50}key|key.{0,50}leaked/i.test(detail)) {
    // Preserve the shared access-denied code so bulk imports stop immediately.
    // Never forward the provider payload, which may contain sensitive values.
    return aiError('AI_ACCESS_DENIED', 'Google blocked this Gemini API key because it was reported as leaked. Create a replacement key in Google AI Studio, update GEMINI_API_KEY on the backend, then restart the backend. You can still fill details from pasted product notes.');
  }
  if ([401, 403].includes(status) || status === 400 && /API.?key.*(?:not valid|invalid|expired)/i.test(detail)) {
    return aiError('AI_ACCESS_DENIED', 'Gemini rejected the API key or project access. Check the backend key and its permissions.');
  }
  if (status >= 500) return aiError('AI_PROVIDER_UNAVAILABLE', 'Gemini is temporarily busy or unavailable. Please try Smart Fill again shortly.', true);
  return aiError('AI_REQUEST_REJECTED', 'Gemini could not accept the analysis request. Check the selected model and supported media format.');
}

function responseText(payload) {
  const candidate = payload?.candidates?.[0];
  if (payload?.promptFeedback?.blockReason || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'RECITATION'].includes(candidate?.finishReason)) {
    throw aiError('AI_CONTENT_BLOCKED', 'Gemini declined to analyze this media. You can still enter the product details manually.');
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw aiError('AI_RESPONSE_INCOMPLETE', 'Gemini returned an incomplete answer. Please try Smart Fill again.', true);
  }
  const text = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('').trim();
  if (!text) throw aiError('AI_EMPTY_RESPONSE', 'Gemini returned no product details. Please try Smart Fill again.', true);
  if (text.length > 100000) throw aiError('AI_INVALID_RESPONSE', 'Gemini returned an unreadable answer. Please try Smart Fill again.', true);
  return text;
}

function parseResponse(payload) {
  const text = responseText(payload);
  try {
    const raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected an object');
    return raw;
  } catch { throw aiError('AI_INVALID_RESPONSE', 'Gemini returned an unreadable answer. Please try Smart Fill again.', true); }
}

function groundedResponse(payload) {
  responseText(payload); // Apply the same refusal, size and completion checks.
  const candidate = payload.candidates[0];
  const parts = candidate.content.parts || [];
  const offsets = new Map(); const texts = []; let bytes = 0;
  parts.forEach((part, index) => {
    if (part.thought || typeof part.text !== 'string') return;
    offsets.set(index, { offset: bytes, text: part.text });
    texts.push(part.text); bytes += Buffer.byteLength(part.text, 'utf8') + 1;
  });
  const metadata = candidate.groundingMetadata || {};
  const groundingSupports = (metadata.groundingSupports || []).flatMap(support => {
    const segment = support.segment || {};
    const part = offsets.get(segment.partIndex ?? 0);
    if (!part) return [];
    let start = segment.startIndex ?? 0; let end = segment.endIndex;
    if (end === undefined && typeof segment.text === 'string' && segment.text) {
      const match = part.text.indexOf(segment.text);
      if (match < 0 || part.text.indexOf(segment.text, match + 1) >= 0) return [];
      start = Buffer.byteLength(part.text.slice(0, match), 'utf8');
      end = start + Buffer.byteLength(segment.text, 'utf8');
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > Buffer.byteLength(part.text, 'utf8')) return [];
    return [{ ...support, segment: { ...segment, partIndex: 0, startIndex: part.offset + start, endIndex: part.offset + end } }];
  });
  // Gemini offsets belong to the original Part, measured in UTF-8 bytes.
  // Preserve whitespace and remap each part before the field parser uses them.
  return { text: texts.join('\n'), groundingMetadata: { ...metadata, groundingSupports } };
}

async function generateGeminiJson({ parts, signal, timeoutMs = 60000, maxOutputTokens = 8192, temperature = 0, googleSearch = false }) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw aiError('AI_KEY_MISSING', 'The Gemini API key is missing. Configure it in the backend and restart the backend.');
  const configured = String(process.env.GEMINI_MODEL || '').trim().replace(/^models\//, '').slice(0, 100);
  const cache = cacheFor(key, configured);
  const models = [...new Set([cache.preferred, configured, ...FALLBACK_MODELS].filter(Boolean))].filter(model => !cache.unavailable.has(model));
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let lastError = aiError('AI_MODEL_UNAVAILABLE', 'No supported Gemini model is currently available. Check your project model access, then retry.');
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, signal: requestSignal,
        body: JSON.stringify({ contents: [{ role: 'user', parts }], ...(googleSearch ? { tools: [{ google_search: {} }] } : {}), generationConfig: { temperature, ...(!googleSearch ? { responseMimeType: 'application/json' } : {}), maxOutputTokens } }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw providerError(response.status, payload);
      const raw = googleSearch
        ? groundedResponse(payload)
        : parseResponse(payload);
      cache.preferred = model;
      return { raw, model };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw aiError('AI_TIMEOUT', 'Gemini took too long to respond. Your product details are unchanged; try Smart Fill again shortly.');
      }
      if (!error.contextCode) throw aiError('AI_CONNECTION_FAILED', 'The backend could not connect to Gemini. Check its internet connection and retry.');
      lastError = error;
      if (error.contextCode === 'AI_MODEL_UNAVAILABLE') cache.unavailable.add(model);
      if (!error.retryModel) throw error;
    }
  }
  throw lastError;
}

module.exports = { generateGeminiJson, aiError };
