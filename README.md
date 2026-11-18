# AI DSH Bridge

Локальный OpenAI-совместимый шлюз, который позволяет **DeepSeek Harness
(DSH)** использовать веб-интерфейс `chat.deepseek.com` как провайдера
моделей. API-ключи DeepSeek не нужны: сессия захватывается из браузера
один раз, а `tool_calls` эмулируются DSML-разметкой в prompt с корректным
SSE-стримингом — без `UNKNOWN_TOOL`.

> **Статус: v0.6.4 (scaffold).** Работают `GET /health`, `GET /v1/models`,
> `pnpm webauth`, клиент DeepSeek с PoW, Prompt Builder, DSML-парсер и
> `POST /v1/chat/completions` в обоих режимах — `stream: false` (JSON) и
> `stream: true` (OpenAI SSE с `tool_calls`). Изображения из `content`
> (`image_url`) загружаются в DeepSeek через `upload_file` и передаются
> как `ref_file_ids`. С 0.6.2 подключён **Google ИИ-чат** двумя путями:
> официальный **Gemini API** по ключу (`google-gemini-api-flash`/`-pro`) и
> веб-чат **`gemini.google.com`** по cookie-сессии (`google-gemini-web`,
> `pnpm webauth:google`). В 0.6.3 Gemini API принимает изображения
> (`inlineData`), а веб-чат получил выбор модели (`-flash`/`-pro`);
> в 0.6.4 изображения работают и в веб-чате (upload + `f.req`).
> Веб-протокол подтверждён живым e2e. DSH подключается как Custom Provider;
> сквозной tool-call цикл подтверждён живым e2e DSH (`bash` выполнен,
> результат возвращён в модель) (см.
> [DESIGN § 10](docs/DESIGN.md#10-этапы-реализации)
> и [DESIGN_GOOGLE.md](docs/DESIGN_GOOGLE.md)).

> ⚠️ **Использование веб-сессии DeepSeek может нарушать условия сервиса и
> привести к блокировке аккаунта.** Используйте отдельный аккаунт и только
> для личных экспериментов.

---

## Требования

- **Node.js 22+** (ESM, `fetch`, `--env-file-if-exists`)
- **pnpm 9+**
- **Google Chrome** — нужен только для `pnpm webauth` / `pnpm webauth:google`
- Действующий аккаунт DeepSeek для входа в браузере
- (опционально) API-ключ Google AI Studio — для Gemini API
- (опционально) аккаунт Google с доступом к Gemini — для Gemini Web
- Свободные порты `3456` (шлюз) и `9222` (CDP)

## Установка

```powershell
git clone https://github.com/iilmchat/ai-dsh-bridge.git
cd ai-dsh-bridge
pnpm install
```

`.env` опционален: без него применяются значения по умолчанию
(`PORT=3456`, `~/.ai-dsh-bridge/...`). Для нестандартных порта/путей
скопируйте `.env.example` → `.env` (`Copy-Item .env.example .env`).

## Аутентификация

```powershell
pnpm webauth
```

Скрипт подключится к Chrome по CDP (`:9222`) или запустит его с отдельным
профилем и откроет `https://chat.deepseek.com`. **Войдите в аккаунт
вручную** — после входа шлюз извлечёт `ds_session_id`, Bearer-токен и
`aws-waf-token` и сохранит их в `~/.ai-dsh-bridge/auth.json` (права `0600`,
файл вне репозитория и не попадает в git). Таймаут ожидания входа — 5 минут.

## Запуск

```powershell
pnpm dev
```

Если старый процесс завис на порту `3456`: `pnpm dev:kill` — найдёт PID,
остановит его и запустит `pnpm dev` заново. Текущая версия:
`pnpm run version` (команда `pnpm version` зарезервирована pnpm под
semver-bump).

Шлюз слушает `http://localhost:3456`. Проверка:

```powershell
Invoke-RestMethod http://localhost:3456/health
Invoke-RestMethod http://localhost:3456/v1/models
```

Если порт `3456` занят: `$env:PORT = '3457'; pnpm dev` и обновите URL в DSH.

## Настройка DSH

В DSH: **Settings → Models → Add Custom Provider**.

| Поле | Значение |
|---|---|
| Base URL | `http://localhost:3456/v1` |
| API Key | любая непустая строка, например `sk-dummy` (шлюз ключ не проверяет) |
| Model | `deepseek-web-chat` (также доступны `deepseek-web-reasoner`, `google-gemini-api-flash`, `google-gemini-api-pro`, `google-gemini-web`, `google-gemini-web-flash`, `google-gemini-web-pro`) |

> В некоторых сборках DSH поле называется `openaiURL` и требует **полный
> URL** эндпоинта — тогда укажите
> `http://localhost:3456/v1/chat/completions`. Кнопка «Fetch available
> models» обращается к `GET /v1/models`.

## Google ИИ-чат (Gemini)

Шлюз поддерживает два независимых пути к Google — их можно включить по
отдельности (подробности: [DESIGN_GOOGLE.md](docs/DESIGN_GOOGLE.md)).

### Gemini API (официальный, по ключу)

1. Получите ключ в [Google AI Studio](https://aistudio.google.com/apikey).
2. Добавьте в `.env`: `GEMINI_API_KEY=...` (опционально
   `GEMINI_API_BASE_URL`, `GEMINI_TIMEOUT_MS=120000`).
3. Перезапустите `pnpm dev` и выберите в DSH модель
   `google-gemini-api-flash` или `google-gemini-api-pro`. Модели принимают
   изображения (`image_url`) и передают их как `inlineData`.

### Gemini Web (cookie-сессия `gemini.google.com`)

```powershell
pnpm webauth:google
```

Скрипт подключится к Chrome по CDP (`:9222`) или запустит его с отдельным
профилем и откроет `https://gemini.google.com/app`. **Войдите в Google
вручную** — после входа шлюз сохранит cookie в
`~/.ai-dsh-bridge/google-auth.json` (права `0600`, файл вне репозитория).
Таймаут ожидания входа — 5 минут. Затем выберите в DSH модель
`google-gemini-web` (модель Google по умолчанию),
`google-gemini-web-flash` или `google-gemini-web-pro`.

> Веб-чат — неофициальный путь: протокол может измениться без предупреждения
> (KI-1019). Изображения поддерживаются: загружаются в Google и передаются
> модели (`content-push` + `f.req`). Использование веб-чата может нарушать
> условия Google — отдельный аккаунт.

## Проверка

После `pnpm webauth`:

```powershell
pnpm e2e:deepseek
```

Ожидание: `[8] E2E OK` и `[7] Assembled text: "..."`. Скрипт проверяет
сессию, PoW, `chat_session/create`, SSE-поток и сборку текста; лог
сохраняется в `docs/captures/e2e-*.log` (локально, gitignored).

Проверка Google-провайдеров:

```powershell
pnpm e2e:gemini        # Gemini Web (после pnpm webauth:google)
pnpm e2e:gemini --api  # Gemini API (нужен GEMINI_API_KEY)
```

Диагностика DSML (когда модель должна вызвать инструмент):

```powershell
pnpm e2e:tools -- --verbose      # живой прогон
pnpm e2e:tools -- --prompt-only  # только prompt, без сети
```

## Что дальше

Планы развития — в [docs/ROADMAP.md](docs/ROADMAP.md). v0.6.0
(Vision & Multimodal) закрыта: скриншот и OCR через `bash`, изображения —
нативно через `upload_file` + `ref_file_ids` (LLaVA отложена, отдельная
обёртка `screenshot` не нужна). v0.6.2 добавила Google-провайдеры (Gemini API
и Gemini Web), v0.6.3 — изображения для Gemini API, модели
`google-gemini-web-flash`/`-pro` и живой e2e веб-протокола, v0.6.4 —
изображения в Gemini Web (upload + `f.req`); см.
[DESIGN_GOOGLE.md](docs/DESIGN_GOOGLE.md). Следующая —
v0.7.0 Performance & Reliability (ускорение PoW, инкрементальный streaming,
автовосстановление сессии), затем v0.8.0 Ecosystem (npm/Docker/reasoner/метрики)
и v0.9.0 Advanced (CDP-fallback и др.). Идеи продублированы в
[docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) как backlog.

## Документация

- [DESIGN.md](docs/DESIGN.md) — назначение, архитектура, DSML/`tool_calls`,
  PoW, этапы реализации и риски. **Начните отсюда.**
- [DESIGN_GOOGLE.md](docs/DESIGN_GOOGLE.md) — Google-провайдеры: Gemini API
  и веб-чат `gemini.google.com`, протокол, ошибки, ограничения.
- [ROADMAP.md](docs/ROADMAP.md) — карта развития v0.6.0–v0.9.0.
- [DESIGN_V06_VISION.md](docs/DESIGN_V06_VISION.md) — черновик Vision &
  Multimodal (OCR/LLaVA/CDP).
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — C4-модель, компоненты, SSE-контракт.
- [GETTING_STARTED.md](docs/GETTING_STARTED.md) — установка, webauth, DSH, e2e,
  troubleshooting, переменные окружения.
- [RULES.md](docs/RULES.md) — инженерные правила проекта.
- [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — реестр известных проблем.
- [CHANGELOG.md](docs/CHANGELOG.md) — история изменений.
- [PROMPT_CURRENT.md](docs/PROMPT_CURRENT.md) — актуальный промпт ассистента.
- [RELEASES.md](docs/RELEASES.md) — чек-лист релиза.
- [KI_GITHUB_SYNC.md](docs/KI_GITHUB_SYNC.md) — синхронизация KI в GitHub Issues.
- [api-contract.json](docs/api-contract.json) — контракт OpenAI/SSE.

## Безопасность

- `auth.json` хранится в `~/.ai-dsh-bridge/` и не попадает в git.
- Токены, cookie и промпты не логируются целиком; «сырые» ответы DeepSeek
  пишутся только в `~/.ai-dsh-bridge/debug/` и только при `DEBUG=1`.
- Шлюз слушает loopback и **не проверяет API-ключ** — не публикуйте его в
  сеть и не выставляйте наружу.
- Не коммитьте `docs/captures/*.http`, `*.sse`, `*.log` — там могут быть
  токены и содержимое диалогов; они исключены через `.gitignore`.

## Лицензия

[MIT](LICENSE)
