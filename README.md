# Baldev Communication backend

## Product Smart Fill providers

Set `GEMINI_API_KEY` and/or `OPENAI_API_KEY` in the backend hosting environment, or in the local `backend/.env`. Restart or redeploy after changing them. Product, Quick Add and Product Draft forms show a Gemini / ChatGPT selector; providers without a key are disabled. The choice applies to both photo/notes analysis and cited web specification lookup. A failed request never switches providers automatically.

`OPENAI_MODEL` is optional and defaults to `gpt-5.4-mini`. Any override must support Responses API image inputs, JSON output and the `web_search` tool. Enable API billing and model access for that project. Secrets must stay on the backend, never in frontend environment variables or source files. Status responses reveal only configuration availability, not credentials.

Suggestions use the same category, evidence and variant checks for both providers. Users review and apply the suggestions before saving. Web warranty and box information still require confirmation for the actual item. Existing reel video processing uses Gemini. Explicit notes can be parsed without AI when neither provider is configured.

Responses include `specificationLookup` with a status, verified field count and a safe failure code/message. The frontend automatically fills cited technical specifications into empty mobile/electronics fields, with an opt-out and undo. It never automatically applies warranty, box contents, condition, prices or stock. Quick Add's technology photo flow uses this same endpoint. `AI_QUOTA_EXCEEDED` means the provider blocked the request; repair the API project's billing/limits or wait for the limit to reset. Repeated Smart Fill requests cannot resolve an exhausted quota.

Official references: [Responses image inputs](https://developers.openai.com/api/docs/guides/images-vision), [web search and citations](https://developers.openai.com/api/docs/guides/tools-web-search), [default model](https://developers.openai.com/api/docs/models/gpt-5.4-mini).
