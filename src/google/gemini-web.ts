/**
 * Клиент веб-чата `gemini.google.com` (L3) без официального API.
 *
 * Используется та же идея, что и для `chat.deepseek.com`: cookie-сессия
 * захватывается браузером (`pnpm webauth:google`), а запрос уходит напрямую
 * из Node.js. Протокол — `StreamGenerate` с формой `at`/`f.req`; ответ
 * приходит несколькими кадрами `wrb.fr`, текст ответа лежит в
 * `part[2] → [4][i][1][0]` (сверено с открытой реализацией `gemini_webapi`,
 * см. `docs/DESIGN_GOOGLE.md`). Протокол неофициальный: при изменении
 * Google ответов парсер вернёт `KI-1019`.
 *
 * Инструменты, как и у DeepSeek, эмулируются DSML-инструкцией в промпте —
 * отдельный реконструктор не нужен (ARCHITECTURE § 8.1).
 */
import { randomUUID } from 'node:crypto';
import type { GoogleAuth } from './auth.js';
import { cookieHeaderValue, loadGoogleAuthAsync } from './auth.js';
import { combineSignals, errorMessage, googleRequestAsync, isAbortError, type FetchAsync, type HttpResponseLike } from './http.js';
import {
  ProviderRequestError,
  ZERO_USAGE,
  type ChatProvider,
  type ProviderCompletionRequest,
  type ProviderCompletionResult,
} from '../providers/types.js';

/** Базовый URL веб-чата Google по умолчанию. */
export const GEMINI_WEB_BASE_URL = 'https://gemini.google.com';

/** Эндпоинт генерации (неофициальный). */
const GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';

/** Страница, из HTML которой берётся access token `SNlM0e`. */
const APP_PATH = '/app';

/** Эндпоинт загрузки файлов Google (content-push). */
const UPLOAD_URL = 'https://content-push.googleapis.com/upload';

/** `Push-ID` для загрузки (как в веб-клиенте Gemini). */
const UPLOAD_PUSH_ID = 'feeds/mcudyrk2a4khkz';

/** Tenant для загрузки файлов Gemini. */
const UPLOAD_TENANT_ID = 'bard-storage';

/** Таймаут запроса по умолчанию: веб-чат отвечает дольше API. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Срок жизни закэшированного `SNlM0e`, мс. */
const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

/** User-Agent, совместимый с веб-клиентом Google. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Access token `SNlM0e` в HTML страницы `/app`. */
const ACCESS_TOKEN_PATTERN = /"SNlM0e":"(.*?)"/u;

/** Код ошибки Google: исчерпан лимит запросов модели. */
const ERROR_USAGE_LIMIT = 1037;

/** Код ошибки Google: заголовок/структура модели устарели. */
const ERROR_MODEL_INVALID = 1052;

/**
 * Заголовки выбора модели Gemini Web (`x-goog-ext-525001261-jspb`).
 *
 * Значения — непрозрачные идентификаторы модели у Google; взяты из открытой
 * реализации `gemini_webapi` v1.14.4 и подтверждены живым e2e 2026-11-18.
 * Если Google их сменит, upstream вернёт код 1052 (KI-1019).
 */
export const GEMINI_WEB_MODEL_HEADERS: Readonly<Record<string, string>> = {
  'gemini-2.5-flash': '[1,null,null,null,"71c2d248d3b102ff"]',
  'gemini-2.5-pro': '[1,null,null,null,"2525e3954d185b3c"]',
};

/** Код ошибки Google: IP временно заблокирован. */
const ERROR_IP_BLOCKED = 1060;

/** Параметры фабрики клиента (для тестов). */
export interface GeminiWebProviderOptions {
  /** Путь к `google-auth.json`. */
  readonly authFile: string;
  /** Базовый URL (по умолчанию `https://gemini.google.com`). */
  readonly baseUrl?: string | undefined;
  /** Таймаут запроса, мс. */
  readonly timeoutMs?: number | undefined;
  /** Заголовок выбора модели `x-goog-ext-525001261-jspb` (опционально). */
  readonly modelHeader?: string | undefined;
  /** Карта `upstreamModel → заголовок модели` (по умолчанию `GEMINI_WEB_MODEL_HEADERS`). */
  readonly modelHeaders?: Readonly<Record<string, string>> | undefined;
  /** Функция HTTP-запроса (по умолчанию `fetch`). */
  readonly fetchImpl?: FetchAsync | undefined;
  /** Часы (для тестов TTL access token). */
  readonly now?: (() => number) | undefined;
  /** Загрузчик cookie-сессии (по умолчанию `loadGoogleAuthAsync`). */
  readonly loadAuth?: ((authFile: string) => Promise<GoogleAuth>) | undefined;
}

/**
 * Извлекает access token `SNlM0e` из HTML страницы.
 * @param html HTML страницы `gemini.google.com/app`.
 * @returns Токен или `undefined`, если его нет (страница входа).
 */
export const extractAccessToken = (html: string): string | undefined => {
  const match = ACCESS_TOKEN_PATTERN.exec(html);
  const token = match?.[1];
  return token === undefined || token === '' ? undefined : token;
};

/**
 * Получает `SNlM0e` запросом страницы `/app` с cookie-сессией.
 *
 * Токен не хранится в `google-auth.json`: он меняется чаще cookie и легко
 * перевыпускается этим запросом (как в `gemini_webapi.get_access_token`).
 *
 * @param auth Cookie-сессия Google.
 * @param options HTTP-клиент, базовый URL, таймаут и сигнал отмены.
 * @returns Access token для формы `at`.
 * @throws ProviderRequestError если сессия истекла или токен не найден.
 */
export const resolveAccessTokenAsync = async (
  auth: GoogleAuth,
  options: {
    readonly fetchImpl?: FetchAsync | undefined;
    readonly baseUrl?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<string> => {
  const fetchImpl = options.fetchImpl ?? googleRequestAsync;
  const baseUrl = (options.baseUrl ?? GEMINI_WEB_BASE_URL).replace(/\/+$/u, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: HttpResponseLike;
  try {
    response = await fetchImpl(`${baseUrl}${APP_PATH}`, {
      method: 'GET',
      headers: {
        cookie: cookieHeaderValue(auth.cookies),
        'user-agent': USER_AGENT,
        'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      signal: combineSignals(options.signal, timeoutMs),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new ProviderRequestError(`gemini.google.com не ответил за ${String(timeoutMs)} мс`, 504);
    }
    throw new ProviderRequestError(
      `Не удалось подключиться к gemini.google.com: ${errorMessage(error)}`,
      502,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ProviderRequestError(
      'Сессия Google недействительна. Запустите pnpm webauth:google.',
      401,
    );
  }
  // Google отвечает 3xx, если cookie не приняты (страница входа/consent).
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderRequestError(
      'Сессия Google недействительна (редирект на вход). Запустите pnpm webauth:google.',
      401,
    );
  }
  if (!response.ok) {
    throw new ProviderRequestError(
      `gemini.google.com вернул HTTP ${String(response.status)}`,
      response.status === 429 ? 503 : 502,
    );
  }

  const token = extractAccessToken(await response.text());
  if (token === undefined) {
    throw new ProviderRequestError(
      'Не удалось извлечь SNlM0e: войдите в gemini.google.com и повторите pnpm webauth:google.',
      401,
    );
  }
  return token;
};

/** Файл, загруженный в Gemini и готовый к упоминанию в `f.req`. */
export interface GeminiWebFile {
  /** Идентификатор `/contrib_service/...`. */
  readonly id: string;
  /** Имя файла (передаётся рядом с id). */
  readonly name: string;
}

/** Файл для загрузки в Gemini (изображение из `image_url`). */
export interface GeminiWebUploadInput {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly fileName: string;
}

/**
 * Собирает тело POST-запроса `StreamGenerate`.
 *
 * Протокол: `at` — access token, `f.req` — JSON `[null, "<inner>"]`, где
 * `inner` — JSON `[messageContent, null, null]`. Без файлов
 * `messageContent = [prompt]`; с файлами — `[prompt, 0, null, files]`,
 * где `files = [[[id], имя], ...]` (формат `gemini_webapi`).
 *
 * @param prompt Полный prompt (системная инструкция + транскрипт).
 * @param accessToken Значение `SNlM0e`.
 * @param files Загруженные файлы (изображения).
 * @returns URL-кодированная строка формы.
 */
export const buildGenerateRequestBody = (
  prompt: string,
  accessToken: string,
  files: readonly GeminiWebFile[] = [],
): string => {
  const messageContent =
    files.length === 0
      ? [prompt]
      : [prompt, 0, null, files.map((file) => [[file.id], file.name])];
  const inner = JSON.stringify([messageContent, null, null]);
  const fReq = JSON.stringify([null, inner]);
  return new URLSearchParams({ at: accessToken, 'f.req': fReq }).toString();
};

/**
 * Определяет расширение файла по MIME-типу.
 * @param mimeType MIME-тип изображения.
 */
const extensionForMimeType = (mimeType: string): string => {
  const subtype = mimeType.toLowerCase().split('/')[1] ?? 'png';
  const normalized = subtype === 'jpeg' ? 'jpg' : subtype === 'svg+xml' ? 'svg' : subtype;
  const safe = normalized.replaceAll(/[^a-z0-9]/gu, '');
  return safe === '' ? 'png' : safe;
};

/**
 * Формирует имя файла для multipart по индексу и MIME-типу.
 * @param index Индекс изображения.
 * @param mimeType MIME-тип.
 */
const imageFileName = (index: number, mimeType: string): string =>
  `image-${String(index + 1)}.${extensionForMimeType(mimeType)}`;

/**
 * Собирает multipart-тело с единственным полем `file`.
 * @param file Данные файла.
 * @param boundary Граница multipart.
 */
const buildMultipartBody = (file: GeminiWebUploadInput, boundary: string): Uint8Array => {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
    'utf8',
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([header, Buffer.from(file.data), footer]);
};

/**
 * Загружает файл в Google (`content-push`) и возвращает id для `f.req`.
 *
 * Сверено с `gemini_webapi.utils.upload_file`: POST multipart с полем
 * `file`, заголовки `Push-ID`/`X-Tenant-Id`, ответ — текстовый id.
 *
 * @param file Данные файла.
 * @param options HTTP-клиент, таймаут, сигнал отмены.
 * @returns `id` и `name` для сообщения Generation.
 * @throws ProviderRequestError если загрузка не удалась.
 */
export const uploadGeminiFileAsync = async (
  file: GeminiWebUploadInput,
  options: {
    readonly fetchImpl?: FetchAsync | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<GeminiWebFile> => {
  const fetchImpl = options.fetchImpl ?? googleRequestAsync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const boundary = `----ai-dsh-bridge-${randomUUID()}`;

  let response: HttpResponseLike;
  try {
    response = await fetchImpl(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'push-id': UPLOAD_PUSH_ID,
        'x-tenant-id': UPLOAD_TENANT_ID,
        origin: GEMINI_WEB_BASE_URL,
        referer: `${GEMINI_WEB_BASE_URL}/`,
      },
      body: buildMultipartBody(file, boundary),
      signal: combineSignals(options.signal, timeoutMs),
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new ProviderRequestError(
        `Загрузка изображения в Gemini не завершилась за ${String(timeoutMs)} мс`,
        504,
      );
    }
    throw new ProviderRequestError(
      `Не удалось загрузить изображение в Gemini: ${errorMessage(error)}`,
      502,
    );
  }

  const id = (await response.text()).trim();
  if (!response.ok) {
    throw new ProviderRequestError(
      `Google отклонил загрузку изображения (HTTP ${String(response.status)})`,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  if (id === '') {
    throw new ProviderRequestError('Gemini не вернул id загруженного изображения', 502);
  }
  return { id, name: file.fileName };
};

/**
 * Читает JSON-кадры ответа `StreamGenerate`.
 *
 * Ответ начинается с `)]}'` и содержит по кадру в строке; строки, которые не
 * являются JSON-массивом, пропускаются (совместимость с изменениями формата).
 *
 * @param raw Тело ответа целиком.
 * @returns Разобранные кадры.
 */
const readFrames = (raw: string): unknown[] => {
  const frames: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) {
      continue;
    }
    try {
      frames.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Не кадр (например, обрезанный чанк) — пропускаем.
    }
  }
  return frames;
};

/**
 * Извлекает самый длинный текст кандидата из кадра.
 *
 * Кадры приходят инкрементально, поэтому финальный текст — самый длинный
 * вариант одного и того же кандидата.
 *
 * @param frame Разобранный кадр.
 * @returns Текст или `undefined`, если в кадре нет кандидатов.
 */
const extractCandidateText = (frame: unknown): string | undefined => {
  if (!Array.isArray(frame)) {
    return undefined;
  }
  let best: string | undefined;
  for (const part of frame) {
    if (!Array.isArray(part) || typeof part[2] !== 'string') {
      continue;
    }
    let inner: unknown;
    try {
      inner = JSON.parse(part[2]) as unknown;
    } catch {
      continue;
    }
    if (!Array.isArray(inner)) {
      continue;
    }
    const candidates = inner[4];
    if (!Array.isArray(candidates)) {
      continue;
    }
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) {
        continue;
      }
      const texts = candidate[1];
      if (!Array.isArray(texts)) {
        continue;
      }
      const text = texts[0];
      if (typeof text === 'string' && text !== '' && (best === undefined || text.length > best.length)) {
        best = text;
      }
    }
  }
  return best;
};

/**
 * Читает число по пути вложенных массивов.
 * @param value Корневое значение.
 * @param path Индексы вложенности.
 * @returns Число или `undefined`, если путь не ведёт к числу.
 */
const readNestedNumber = (value: unknown, path: readonly number[]): number | undefined => {
  let current: unknown = value;
  for (const index of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }
    current = current[index];
  }
  return typeof current === 'number' ? current : undefined;
};

/**
 * Извлекает код ошибки Google из кадров (`part[5][2][0][1][0]`).
 * @param frames Разобранные кадры ответа.
 * @returns Код ошибки или `undefined`.
 */
const extractErrorCode = (frames: readonly unknown[]): number | undefined => {
  for (const frame of frames) {
    if (!Array.isArray(frame)) {
      continue;
    }
    for (const part of frame) {
      if (!Array.isArray(part)) {
        continue;
      }
      const code = readNestedNumber(part, [5, 2, 0, 1, 0]);
      if (code !== undefined) {
        return code;
      }
    }
  }
  return undefined;
};

/**
 * Преобразует код ошибки Google в ошибку шлюза.
 * @param code Код из кадра.
 * @returns Ошибка с HTTP-статусом для DSH.
 */
const mapErrorCode = (code: number): ProviderRequestError => {
  if (code === ERROR_USAGE_LIMIT) {
    return new ProviderRequestError(
      'Достигнут лимит запросов Gemini. Попробуйте позже или выберите другую модель.',
      503,
    );
  }
  if (code === ERROR_MODEL_INVALID) {
    return new ProviderRequestError(
      'Gemini отклонил модель: структура запроса устарела. Обновите шлюз (KI-1019).',
      502,
    );
  }
  if (code === ERROR_IP_BLOCKED) {
    return new ProviderRequestError(
      'Google временно заблокировал IP. Попробуйте другую сеть или подождите.',
      403,
    );
  }
  return new ProviderRequestError(`Gemini Web вернул ошибку ${String(code)}`, 502);
};

/**
 * Создаёт провайдер веб-чата Gemini.
 * @param options Путь к сессии, базовый URL, таймаут, HTTP-клиент, часы.
 * @returns Провайдер с `id: 'google-gemini-web'`.
 */
export const createGeminiWebProvider = (options: GeminiWebProviderOptions): ChatProvider => {
  const baseUrl = (options.baseUrl ?? GEMINI_WEB_BASE_URL).replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? googleRequestAsync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const loadAuth = options.loadAuth ?? loadGoogleAuthAsync;

  /** Кэш access token: уменьшает число запросов страницы `/app`. */
  let cachedToken: { readonly value: string; readonly expiresAt: number } | undefined;

  const accessTokenAsync = async (
    auth: GoogleAuth,
    signal: AbortSignal | undefined,
  ): Promise<string> => {
    const current = now();
    if (cachedToken !== undefined && current < cachedToken.expiresAt) {
      return cachedToken.value;
    }
    const token = await resolveAccessTokenAsync(auth, {
      fetchImpl,
      baseUrl,
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
    cachedToken = { value: token, expiresAt: current + ACCESS_TOKEN_TTL_MS };
    return token;
  };

  const completeAsync = async (
    request: ProviderCompletionRequest,
  ): Promise<ProviderCompletionResult> => {
    const auth = await loadAuth(options.authFile);
    const accessToken = await accessTokenAsync(auth, request.signal);

    const prompt = request.system === '' ? request.conversation : `${request.system}\n\n${request.conversation}`;

    // Изображения сначала загружаются в Google, затем упоминаются в f.req.
    const files: GeminiWebFile[] = [];
    const images = request.images ?? [];
    for (const [index, image] of images.entries()) {
      files.push(
        await uploadGeminiFileAsync(
          {
            data: Buffer.from(image.data, 'base64'),
            mimeType: image.mimeType,
            fileName: imageFileName(index, image.mimeType),
          },
          {
            fetchImpl,
            timeoutMs,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        ),
      );
    }

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      origin: baseUrl,
      referer: `${baseUrl}/`,
      'user-agent': USER_AGENT,
      'x-same-domain': '1',
      cookie: cookieHeaderValue(auth.cookies),
    };
    if (options.modelHeader !== undefined && options.modelHeader !== '') {
      headers['x-goog-ext-525001261-jspb'] = options.modelHeader;
    } else {
      const modelHeaders = options.modelHeaders ?? GEMINI_WEB_MODEL_HEADERS;
      const modelHeader = modelHeaders[request.upstreamModel];
      if (modelHeader !== undefined && modelHeader !== '') {
        headers['x-goog-ext-525001261-jspb'] = modelHeader;
      }
    }

    let response: HttpResponseLike;
    try {
      response = await fetchImpl(`${baseUrl}${GENERATE_PATH}`, {
        method: 'POST',
        headers,
        body: buildGenerateRequestBody(prompt, accessToken, files),
        signal: combineSignals(request.signal, timeoutMs),
      });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new ProviderRequestError(
          `Gemini Web не ответил за ${String(timeoutMs)} мс`,
          504,
        );
      }
      throw new ProviderRequestError(
        `Не удалось подключиться к gemini.google.com: ${errorMessage(error)}`,
        502,
      );
    }

    const raw = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ProviderRequestError(
          'Сессия Google недействительна. Запустите pnpm webauth:google.',
          401,
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRequestError(
          'Сессия Google недействительна (редирект на вход). Запустите pnpm webauth:google.',
          401,
        );
      }
      throw new ProviderRequestError(
        `gemini.google.com вернул HTTP ${String(response.status)}`,
        response.status === 429 ? 503 : 502,
      );
    }

    const frames = readFrames(raw);
    let text = '';
    for (const frame of frames) {
      const candidate = extractCandidateText(frame);
      if (candidate !== undefined && candidate.length > text.length) {
        text = candidate;
      }
    }
    if (text === '') {
      const code = extractErrorCode(frames);
      throw code === undefined
        ? new ProviderRequestError('Gemini Web вернул пустой ответ', 502)
        : mapErrorCode(code);
    }

    return { text, usage: ZERO_USAGE };
  };

  return {
    id: 'google-gemini-web',
    isConfiguredAsync: async (): Promise<boolean> => {
      try {
        await loadAuth(options.authFile);
        return true;
      } catch {
        // Нет файла/битая схема — провайдер просто не настроен (контракт).
        return false;
      }
    },
    completeAsync,
  };
};

/**
 * Проверяет, что cookie-сессия Google рабочая (для `webauth:google`).
 * @param auth Cookie-сессия.
 * @param options HTTP-клиент, базовый URL, таймаут.
 * @returns `true`, если страница `/app` вернула access token.
 */
export const validateGoogleSessionAsync = async (
  auth: GoogleAuth,
  options: {
    readonly fetchImpl?: FetchAsync | undefined;
    readonly baseUrl?: string | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
): Promise<boolean> => {
  try {
    await resolveAccessTokenAsync(auth, options);
    return true;
  } catch {
    // Невалидная сессия — ожидаемый результат проверки, не ошибка.
    return false;
  }
};
