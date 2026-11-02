# Security notes

1. Never commit API keys, cookies, access tokens, or personal research to this repository.
2. A browser-only API key is exposed to the browser runtime and is not suitable for high-value or long-lived credentials, even if it is not persisted.
3. Static hosting has no server-side authentication, request limits, private logs, or secret management.
4. Use a backend proxy for production: authenticate each user, store provider secrets server-side, apply request quotas and timeouts, limit allowed provider hosts, validate request sizes, and avoid logging sensitive prompts.
5. Treat all web snippets as untrusted data. The model prompt asks for source-grounded summaries, but users must still verify claims.
6. Do not point the app at arbitrary endpoints you do not trust. Avoid exposing local model servers to the public internet.
7. Saved discoveries are stored in browser local storage. Anyone with access to the unlocked browser profile may be able to read them. Export and clear data when using a shared device.
