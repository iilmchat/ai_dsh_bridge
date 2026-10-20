# AI DSH Bridge

Локальный OpenAI-совместимый шлюз, который позволяет **DeepSeek Harness (DSH)**
использовать веб-интерфейс `chat.deepseek.com` как провайдера моделей.
Аутентификация выполняется один раз через браузер, а `tool_calls` эмулируются
DSML-разметкой с корректным SSE-стримингом — без `UNKNOWN_TOOL`.

> **Статус: v0.3.1 (scaffold).** Сейчас работают `GET /health`,
> `GET /v1/models`, `pnpm webauth`, клиент DeepSeek с PoW и Prompt Builder;
> `POST /v1/chat/completions` пока отвечает 501. Слой трансляции (DSML-парсер,
> SSE `tool_calls`) — в разработке
> (см. [DESIGN § 10](docs/DESIGN.md#10-этапы-реализации)).

---

## Быстрый старт

```powershell
pnpm install
pnpm webauth          # одноразовый вход в chat.deepseek.com через Chrome
pnpm dev              # шлюз на http://localhost:3456
```

> `.env` опционален: без него применяются значения по умолчанию
> (`PORT=3456` и пути из `config.ts`). Скопируйте `.env.example` → `.env`,
> если нужны нестандартные порт/пути. Подробнее —
> [GETTING_STARTED.md](docs/GETTING_STARTED.md).

Проверка:

```powershell
Invoke-RestMethod http://localhost:3456/health
Invoke-RestMethod http://localhost:3456/v1/models
```

> `pnpm webauth` уже работает (Этап 2). Реальные ответы через DSH появятся
> после подключения слоя трансляции и фасада `POST /v1/chat/completions`
> (KI-002, KI-005); сейчас доступны `/health`, `/v1/models` и `webauth`.

## Настройка DSH

**Settings → Models → Add Custom Provider:**

| Поле | Значение |
|---|---|
| Base URL (`openaiURL`) | `http://localhost:3456/v1/chat/completions` |
| API Key | любая непустая строка, например `sk-dummy` (шлюз ключ не проверяет) |
| Model | `deepseek-web-chat` (также доступна `deepseek-web-reasoner`) |

Важно: DSH ожидает **полный URL** эндпоинта, а не базовый префикс. При
добавлении провайдера можно нажать «Fetch available models» — DSH обратится
к `GET /v1/models`.

> Если порт 3456 занят (например, другим локальным шлюзом), запустите
> `PORT=3457 pnpm dev` (в PowerShell: `$env:PORT = '3457'; pnpm dev`) и
> укажите в DSH `openaiURL: http://localhost:3457/v1/chat/completions`.

## Документация

- [DESIGN.md](docs/DESIGN.md) — назначение, архитектура, слой DSML, риски.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — C4-модель, компоненты, сценарии.
- [GETTING_STARTED.md](docs/GETTING_STARTED.md) — установка и первые шаги.
- [RULES.md](docs/RULES.md) — инженерные правила проекта.
- [KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) — реестр известных проблем.
- [CHANGELOG.md](docs/CHANGELOG.md) — история изменений.
- [PROMPT_CURRENT.md](docs/PROMPT_CURRENT.md) — актуальный промпт ассистента.
- [RELEASES.md](docs/RELEASES.md) — чек-лист релиза.
- [KI_GITHUB_SYNC.md](docs/KI_GITHUB_SYNC.md) — синхронизация KI в GitHub Issues.
- [api-contract.json](docs/api-contract.json) — контракт OpenAI/SSE.

## Требования

- Node.js 22+
- pnpm 9+
- Chrome (для `webauth`)

## Безопасность

- `auth.json` хранится в `~/.ai-dsh-bridge/` и не попадает в git.
- Токены и промпты не логируются целиком; «сырые» ответы DeepSeek пишутся
  только в `~/.ai-dsh-bridge/debug/` и только при `DEBUG=1`.
- Шлюз слушает loopback и не проверяет API-ключ — не публикуйте его в сеть.
- Использование веб-сессии DeepSeek может нарушать условия сервиса и привести
  к блокировке аккаунта. Рекомендуется отдельный аккаунт.

## Лицензия

[MIT](LICENSE)
