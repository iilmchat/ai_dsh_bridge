# AI DSH Bridge

Локальный OpenAI-совместимый шлюз, который позволяет **DeepSeek Harness
(DSH)** использовать веб-интерфейс `chat.deepseek.com` как провайдера
моделей. API-ключи DeepSeek не нужны: сессия захватывается из браузера
один раз, а `tool_calls` эмулируются DSML-разметкой в prompt с корректным
SSE-стримингом — без `UNKNOWN_TOOL`.

> **Статус: v0.5.4 (scaffold).** Работают `GET /health`, `GET /v1/models`,
> `pnpm webauth`, клиент DeepSeek с PoW, Prompt Builder, DSML-парсер и
> `POST /v1/chat/completions` в обоих режимах — `stream: false` (JSON) и
> `stream: true` (OpenAI SSE с `tool_calls`). DSH подключается как
> Custom Provider; сквозной tool-call цикл подтверждён живым e2e DSH
> (`bash` выполнен, результат возвращён в модель)
> (см. [DESIGN § 10](docs/DESIGN.md#10-этапы-реализации)).

> ⚠️ **Использование веб-сессии DeepSeek может нарушать условия сервиса и
> привести к блокировке аккаунта.** Используйте отдельный аккаунт и только
> для личных экспериментов.

---

## Требования

- **Node.js 22+** (ESM, `fetch`, `--env-file-if-exists`)
- **pnpm 9+**
- **Google Chrome** — нужен только для `pnpm webauth`
- Действующий аккаунт DeepSeek для входа в браузере
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
| Model | `deepseek-web-chat` (также доступна `deepseek-web-reasoner`) |

> В некоторых сборках DSH поле называется `openaiURL` и требует **полный
> URL** эндпоинта — тогда укажите
> `http://localhost:3456/v1/chat/completions`. Кнопка «Fetch available
> models» обращается к `GET /v1/models`.

## Проверка

После `pnpm webauth`:

```powershell
pnpm e2e:deepseek
```

Ожидание: `[8] E2E OK` и `[7] Assembled text: "..."`. Скрипт проверяет
сессию, PoW, `chat_session/create`, SSE-поток и сборку текста; лог
сохраняется в `docs/captures/e2e-*.log` (локально, gitignored).

Диагностика DSML (когда модель должна вызвать инструмент):

```powershell
pnpm e2e:tools -- --verbose      # живой прогон
pnpm e2e:tools -- --prompt-only  # только prompt, без сети
```

## Документация

- [DESIGN.md](docs/DESIGN.md) — назначение, архитектура, DSML/`tool_calls`,
  PoW, этапы реализации и риски. **Начните отсюда.**
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
