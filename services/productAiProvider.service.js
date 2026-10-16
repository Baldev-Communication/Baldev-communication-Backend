const { generateGeminiJson, aiError } = require('./geminiJson.service');
const { generateOpenAIProduct } = require('./openaiProduct.service');

const definitions = [
  { id: 'gemini', label: 'Gemini', environmentKey: 'GEMINI_API_KEY' },
  { id: 'openai', label: 'ChatGPT', environmentKey: 'OPENAI_API_KEY' },
];
const supportedProvider = provider => definitions.some(item => item.id === provider);
const providerLabel = provider => definitions.find(item => item.id === provider)?.label || 'AI';
const enabled = (provider = 'gemini') => Boolean(String(process.env[definitions.find(item => item.id === provider)?.environmentKey] || '').trim());
const providers = () => definitions.map(({ id, label }) => ({ id, label, enabled: enabled(id), webSupported: enabled(id) }));
const defaultProvider = () => providers().find(item => item.enabled)?.id || 'gemini';

function generateProductJson({ provider = 'gemini', webSearch = false, ...options }) {
  if (!supportedProvider(provider)) throw aiError('AI_PROVIDER_INVALID', 'Choose Gemini or ChatGPT for Smart Fill.');
  return provider === 'openai' ? generateOpenAIProduct({ ...options, webSearch }) : generateGeminiJson({ ...options, googleSearch: webSearch });
}

module.exports = { enabled, providers, defaultProvider, providerLabel, supportedProvider, generateProductJson };
