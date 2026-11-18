# DESIGN — Google-провайдеры (Gemini API и Gemini Web)

**Версия:** 1.2 · **Дата:** 2026-11-18 · **Статус:** реализовано в 0.6.2–0.6.4
**Связанные документы:** [DESIGN.md](DESIGN.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[ROADMAP.md](ROADMAP.md), [KNOWN_ISSUES.md](KNOWN_ISSUES.md), [RULES.md](RULES.md).

---

## 1. Зачем

До 0.6.2 шлюз умел работать только с `chat.deepseek.com`, а DSH мог выбрать
две модели одного провайдера. Задача: дать DSH возможность подключаться к
**Google ИИ-чату** двумя независимыми путями:

| Вариант | Что это | Авторизация | Модели шлюза |
|---|---|---|---|
| **Gemini API** | Официальный `generativelanguage.googleapis.com` | API-ключ Google AI Studio (`GEMINI_API_KEY`) | `google-gemini-api-flash`, `google-gemini-api-pro` |
| **Gemini Web** | Веб-чат `gemini.google.com` (неофициально) | cookie-сессия Google, `pnpm webauth:google` | `google-gemini-web` |

Оба варианта проходят через общий L2 (Prompt Builder + DSML-парсер), поэтому
`tool_calls` эмулируются одинаково и контракт DSH не меняется
(ARCHITECTURE § 8.1).

---

## 2. Архитектура

    ┌──────────── DSH: /v1/chat/completions ────────────┐
    │ L1: Fastify (src/api/completions.ts)               │
    │   model → реестр → провайдер                       │
    └───────────────┬────────────────────────────────────┘
                    │
    ┌───────────────▼────────────────────────────────────┐
    │ L2: Prompt Builder + DSML-парсер (общий)            │
    │   system = system-сообщения + DSML-инструкция       │
    │   conversation = [USER]/[ASSISTANT]/[TOOL_RESULT]   │
    └───────────────┬────────────────────────────────────┘
                    │
       ┌────────────┴─────────────┬──────────────────────┐
       ▼                          ▼                      ▼
    DeepSeek Web            Gemini API              Gemini Web
    (как раньше)        src/google/gemini-api.ts  src/google/gemini-web.ts

Ключевые модули:

| Файл | Назначение |
|---|---|
| `src/providers/types.ts` | контракт `ChatProvider`, ошибки `ProviderNotConfiguredError`/`ProviderRequestError` |
| `src/providers/model-registry.ts` | `PROVIDER_MODELS`: id → провайдер/upstream-модель; используется `/v1/models` и роутингом |
| `src/google/gemini-api.ts` | клиент официального API (ключ, `:generateContent`) |
| `src/google/gemini-web.ts` | клиент веб-чата (`StreamGenerate`, `SNlM0e`, cookie) |
| `src/google/auth.ts` | `google-auth.json`: схема, загрузка/сохранение, заголовок `Cookie` |
| `src/google/http.ts` | `FetchAsync`, `AbortSignal` + таймаут, безопасный текст ошибки |
| `src/auth/webauth-google.ts` | `pnpm webauth:google`: CDP-захват cookie `gemini.google.com` |

`ChatProvider.completeAsync` возвращает **полный текст** ответа и usage;
шлюз по-прежнему буферизует ответ перед SSE (DESIGN § 5.3), поэтому
инкрементальный streaming не требуется (см. R-07-02).

---

## 3. Реестр моделей

`PROVIDER_MODELS` — единственный источник истины:

| `id` (DSH) | `provider` | `upstreamModel` |
|---|---|---|
| `deepseek-web-chat` | `deepseek-web` | `default` |
| `deepseek-web-reasoner` | `deepseek-web` | `reasoner` |
| `google-gemini-api-flash` | `google-gemini-api` | `gemini-2.5-flash` |
| `google-gemini-api-pro` | `google-gemini-api` | `gemini-2.5-pro` |
| `google-gemini-web` | `google-gemini-web` | `gemini-web` (модель Google по умолчанию) |
| `google-gemini-web-flash` | `google-gemini-web` | `gemini-2.5-flash` |
| `google-gemini-web-pro` | `google-gemini-web` | `gemini-2.5-pro` |

`GET /v1/models` отдаёт все модели реестра (`owned_by` = `provider`,
`capabilities.tools/function_calling/streaming = true`). Модель, отсутствующая
в реестре, в `POST /v1/chat/completions` даёт `400 invalid_request_error`.

---

## 4. Gemini API (официальный)

### 4.1. Запрос

- `POST {GEMINI_API_BASE_URL}/v1beta/models/{upstreamModel}:generateContent`
- заголовки: `content-type: application/json`, `x-goog-api-key: <GEMINI_API_KEY>`
  (ключ **не** попадает в URL и логи).
- тело:

```json
{
  "systemInstruction": { "parts": [{ "text": "<system + DSML>" }] },
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "<транскрипт>" },
      { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
    ]
  }],
  "generationConfig": { "temperature": 0.2, "maxOutputTokens": 4096 }
}
```

`systemInstruction`/`generationConfig` опускаются, если пусты/не заданы
(`exactOptionalPropertyTypes`, RULES § 4.7). В `contents` уходит один
пользовательский ход: история уже размечена `[USER]`/`[ASSISTANT]`/
`[TOOL_RESULT]`, поэтому отдельная конвертация ролей не нужна и поведение
совпадает с DeepSeek. Изображения из `image_url` (`data:base64` и http(s))
передаются как `inlineData` (0.6.3, KI-1018 для API закрыт).

### 4.2. Ответ

Валидируются только используемые поля (`GeminiResponseSchema`):

- `candidates[0].content.parts[].text` — текст; части с `thought: true`
  (рассуждения) отбрасываются;
- `usageMetadata.promptTokenCount` / `candidatesTokenCount` — usage;
- `promptFeedback.blockReason` — причина блокировки (например, `SAFETY`).

### 4.3. Ошибки

| Условие | Статус шлюза | Сообщение |
|---|---|---|
| нет `GEMINI_API_KEY` | 401 | «GEMINI_API_KEY не задан…» |
| HTTP 401/403 | 401 | текст `error.message` Gemini (усечён до 300 символов) |
| HTTP 429 / 5xx | 503 | текст `error.message` |
| блокировка `blockReason` | 400 | «Gemini заблокировал запрос (…)» |
| пустой ответ без причины | 502 | «Gemini API вернул пустой ответ» |
| таймаут (`GEMINI_TIMEOUT_MS`) | 504 | «Gemini API не ответил за N мс» |
| прочие 4xx / не-JSON | 502 | «Gemini API …» |

---

## 5. Gemini Web (веб-чат, неофициально)

### 5.1. Сессия

`pnpm webauth:google`:

1. Находит Chrome (`CHROME_PATH` или стандартные пути) и подключается к CDP
   (`:9222`) либо запускает Chrome с отдельным профилем
   (`~/.ai-dsh-bridge/chrome-profile`) на `https://gemini.google.com/app`.
2. Ждёт, пока пользователь войдёт в Google (до 5 минут).
3. Читает cookie доменов `google.com` через `Network.getCookies`, требует
   `__Secure-1PSID`, проверяет сессию запросом `/app` (наличие `SNlM0e`) и
   сохраняет `~/.ai-dsh-bridge/google-auth.json` (`0600`).

`google-auth.json` — `z.strictObject`:

```json
{
  "cookies": { "__Secure-1PSID": "…", "__Secure-1PSIDTS": "…" },
  "savedAt": "2026-11-18T00:00:00.000Z"
}
```

Access token `SNlM0e` **не хранится**: он извлекается из HTML страницы `/app`
регуляркой `"SNlM0e":"(.*?)"` и кэшируется в памяти провайдера на 5 минут.

> **Лимит заголовков.** Google отдаёт `/app` и `StreamGenerate` с ~30 КБ
> заголовков (8 `Set-Cookie`), поэтому стандартный `fetch` падает с
> `HeadersOverflowError`. Запросы идут через `undici.Client` с
> `maxHeaderSize: 512 КБ` (`src/google/http.ts`); ответ 3xx считается
> истёкшей сессией (401). Это же исправление понадобилось `webauth:google`,
> иначе валидация молча не проходила и `google-auth.json` не сохранялся.

### 5.2. Протокол генерации

```
POST {GEMINI_WEB_BASE_URL}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
content-type: application/x-www-form-urlencoded;charset=utf-8
origin/referer: https://gemini.google.com
x-same-domain: 1
cookie: <cookies из google-auth.json>

at=<SNlM0e>&f.req=<[null,"[[prompt],null,null]"]>
```

`f.req` — JSON `[null, "<inner JSON>"]`, где `inner` — `[[prompt], null, null]`
(новый диалог, без metadata). Ответ — несколько кадров вида
`[["wrb.fr","StreamGenerate","<inner JSON>",…]]`; текст кандидата лежит в
`inner[4][i][1][0]`, кадры приходят инкрементально, поэтому берётся самый
длинный вариант. Код ошибки — `part[5][2][0][1][0]`.

Протокол сверен с открытой реализацией `HanaokaYuzu/Gemini-API`
(`v1.14.4`, файл `src/gemini_webapi/client.py`, метод `generate_content`) и
подтверждён живыми прогонами 2026-11-18: `google-gemini-web` — 15.6 с,
`-flash` — 8.7 с, `-pro` — 15.0 с (все вернули `pong`).

Выбор модели — заголовок `x-goog-ext-525001261-jspb` из
`GEMINI_WEB_MODEL_HEADERS` (`gemini-2.5-flash`/`gemini-2.5-pro`); для
`google-gemini-web` заголовок не отправляется (модель Google по умолчанию).
Если Google сменит идентификаторы, upstream вернёт код 1052 (KI-1019).

### 5.3. Изображения

Изображения из `image_url` (0.6.4) загружаются отдельно, до генерации:

```
POST https://content-push.googleapis.com/upload
push-id: feeds/mcudyrk2a4khkz
x-tenant-id: bard-storage
origin/referer: https://gemini.google.com

multipart/form-data; field "file"; filename="image-1.png"; Content-Type: image/png
```

Ответ — текстовый идентификатор
`/contrib_service/ttl_1d/<id>`; он передаётся в `f.req`:

```json
[[["<prompt>", 0, null, [[["/contrib_service/ttl_1d/<id>"], "image-1.png"]]], null, null]]
```

Протокол сверен с `gemini_webapi.utils.upload_file` и подтверждён живым
прогоном 2026-11-18: красный квадрат 128×128 через
`POST /v1/chat/completions` → `google-gemini-web` ответил «Красный».
Ограничение — 10 МиБ на изображение (как у DeepSeek). Наблюдался один
транзиентный `Connect Timeout` к `content-push.googleapis.com`; с 0.6.5
загрузка делает до двух попыток с паузой 500 мс при `502`/`504`
(KI-1027 → Fixed).

### 5.4. Ошибки

| Код/условие | Статус шлюза | План |
|---|---|---|
| `1037` | 503 | лимит запросов модели |
| `1052` | 502 | устарел заголовок/структура модели (KI-1019) |
| `1060` | 403 | IP временно заблокирован |
| HTTP 401/403 | 401 | «Запустите pnpm webauth:google» |
| HTTP 429 / 5xx | 503 | временный сбой |
| пустой ответ | 502 | протокол изменился (KI-1017) |

---

## 6. Ограничения

- **Изображения поддерживаются обоими путями**: Gemini API — `inlineData`,
  Gemini Web — upload в `content-push` + `f.req` (0.6.4). Лимит 10 МиБ.
- **Веб-протокол проверен живым прогоном** 2026-11-18 (web/flash/pro и
  изображение), но остаётся неофициальным и может измениться без
  предупреждения (KI-1019).
- **Только один аккаунт**: cookie-сессия одна, как и `auth.json` DeepSeek
  (мультиаккаунтность — R-07-04).
- **Нет инкрементального streaming**: ответ собирается целиком, как и
  раньше (R-07-02).
- **Использование веб-чата может нарушать условия Google**; используйте
  отдельный аккаунт и личные эксперименты (как и для DeepSeek).

---

## 7. Проверка

```powershell
pnpm typecheck
pnpm lint
pnpm test        # 168 тестов, включая gemini-api/gemini-web/webauth-google
pnpm build
```

Юнит-тесты покрывают: тело запроса Gemini API (`systemInstruction`,
`contents`, `generationConfig`), разбор `thought`, usage, маппинг ошибок;
сборку `at`/`f.req`, разбор кадров, выбор самого длинного кандидата, кэш
`SNlM0e`, ошибки веб-чата; захват cookie и таймаут `webauth:google`;
роутинг моделей и `GET /v1/models`.

Живая проверка (нужен аккаунт):

```powershell
$env:GEMINI_API_KEY = '...'   # вариант API
pnpm e2e:gemini --api         # Gemini API: pong + usage

# вариант Web
pnpm webauth:google
pnpm e2e:gemini               # Gemini Web: pong за ~15 с
pnpm e2e:gemini --model gemini-2.5-flash
```

`pnpm e2e:gemini` пишет лог в `docs/captures/e2e-gemini-*.log`
(вне git), cookie и ключи в лог не попадают. Изображения проверены живым
запросом через шлюз (красный квадрат → «Красный»).

---

## 8. Как обновлять веб-протокол

1. Снять захват `StreamGenerate` из DevTools (Network → Copy as cURL),
   сохранить локально в `docs/captures/` (не коммитить: токены).
2. Сверить структуру `f.req`/кадров с открытой реализацией `gemini_webapi`
   (ветка/тег фиксируется в описании KI-1017).
3. Обновить `buildGenerateRequestBody`/`readFrames`/`extractCandidateText`
   и тестовые кадры в `test/gemini-web.test.ts`.
4. Записать изменение в CHANGELOG и закрыть/переоткрыть KI-1017/KI-1019.

## 9. Ссылки

- [Gemini API docs](https://ai.google.dev/gemini-api/docs)
- [gemini_webapi (HanaokaYuzu)](https://github.com/HanaokaYuzu/Gemini-API)
- [api-contract.json](api-contract.json) — внешний контракт OpenAI/SSE.
