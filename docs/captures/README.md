# Захваты запросов DeepSeek

Этап 0 (см. docs/DESIGN.md § 10). Файлы:
- `YYYY-MM-DD-chat-completion.http` — полный запрос POST /api/v0/chat/completion
  (headers + body + ответ).
- `YYYY-MM-DD-chat-completion.sse` — сырой SSE-поток ответа.
- `YYYY-MM-DD-pow-challenge.http` — create_pow_challenge request/response.
- `YYYY-MM-DD-users-current.http` — GET /api/v0/users/current (валидация сессии).
- `YYYY-MM-DD-upload-file.http` — POST /api/v0/file/upload_file:
  multipart/form-data, единственное поле `file`, заголовки `x-file-size`,
  `x-model-type`, `x-thinking-enabled`, PoW под `/api/v0/file/upload_file`
  (S3, KI-1003).
- `YYYY-MM-DD-chat-completion-vision.http` — POST /api/v0/chat/completion
  с `ref_file_ids` (сообщение с изображением, `model_type: default`; S3).

`fork_file_task` (`POST /api/v0/file/fork_file_task`, `{file_id, to_model_type}`)
при загрузке изображения не вызывается — он нужен для смены модели уже
загруженного файла, а не для upload.

Как захватывать — см. GETTING_STARTED.md § 10 «Захват запросов DeepSeek».
