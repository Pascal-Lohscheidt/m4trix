# Never read .env files

`.env`, `.env.local`, `.env.*.local` and other `.env.*` files hold secrets (API keys). Do not open, print, `source`, `grep`, copy or otherwise read them, through any tool or shell command, and never move their values into commands, logs or other files.

- Apps load their own `.env` at startup (e.g. `examples/m4trix-code` via `process.loadEnvFile`), so a run never needs you to export keys.
- If a key is missing, tell the user which variable and file are needed instead of looking for it.
- `.env.example` files contain no secrets and may be read and edited.
