# Захваты запросов DeepSeek

Этап 0 (см. docs/DESIGN.md § 10). Файлы:
- `YYYY-MM-DD-chat-completion.http` — полный запрос POST /api/v0/chat/completion
  (headers + body + ответ).
- `YYYY-MM-DD-chat-completion.sse` — сырой SSE-поток ответа.
- `YYYY-MM-DD-pow-challenge.http` — create_pow_challenge request/response.
- `YYYY-MM-DD-users-current.http` — GET /api/v0/users/current (валидация сессии).

Как захватывать — см. GETTING_STARTED.md § 10 «Захват запросов DeepSeek».
