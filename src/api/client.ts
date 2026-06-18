const API_BASE = (import.meta.env?.VITE_API_BASE_URL as string | undefined) ?? '';

const AUTH_TOKEN_KEY = 'gqbox_auth_token';
const DEV_MODE_KEY = 'gqbox_dev_mode';

export type AuthFailureReason = 'unauthorized' | 'forbidden';

export interface AuthFailureEvent {
  reason: AuthFailureReason;
  status: number;
  message: string;
  // Поля из тела ответа, если бэк их прислал (для 403 от requireAdmin).
  login?: string;
  role?: string;
}

const authFailureListeners = new Set<(e: AuthFailureEvent) => void>();

/**
 * Подписка на auth-failure события. Используется AuthContext, чтобы
 * автоматически сделать logout + redirect на login, если бэк сообщил
 * что токен невалиден (401) или роль не подходит (403). Без этого
 * приложение продолжало бы показывать пустые данные и каскад ошибок.
 */
export function onAuthFailure(listener: (e: AuthFailureEvent) => void): () => void {
  authFailureListeners.add(listener);
  return () => authFailureListeners.delete(listener);
}

function emitAuthFailure(event: AuthFailureEvent): void {
  authFailureListeners.forEach((fn) => {
    try {
      fn(event);
    } catch {
      // best-effort: слушатель не должен ломать request()
    }
  });
}

function readAuthToken(): string | null {
  try {
    return sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem(AUTH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function readModeHeader(): 'demo' | 'dev' {
  try {
    return localStorage.getItem(DEV_MODE_KEY) === 'true' ? 'dev' : 'demo';
  } catch {
    return 'demo';
  }
}

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const isFormData = options?.body instanceof FormData;
  // Для FormData не выставляем Content-Type вручную — браузер сам проставит
  // multipart/form-data с корректным boundary. Для остальных запросов —
  // дефолтный JSON, при этом пользовательский headers имеет приоритет.
  const token = readAuthToken();
  const modeHeader = readModeHeader();
  const headers: HeadersInit = isFormData
    ? {
        'X-GQbox-Mode': modeHeader,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers ?? {}),
      }
    : {
        'Content-Type': 'application/json',
        'X-GQbox-Mode': modeHeader,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers ?? {}),
      };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    let parsedBody: { error?: string; login?: string; role?: string } | null = null;
    try {
      const parsed = JSON.parse(text);
      parsedBody = parsed;
      if (parsed.error || parsed.message) {
        msg = parsed.error || parsed.message;
      }
    } catch {
      // not JSON, keep raw text
    }
    if (res.status === 401 || res.status === 403) {
      emitAuthFailure({
        reason: res.status === 401 ? 'unauthorized' : 'forbidden',
        status: res.status,
        message: msg,
        login: parsedBody?.login,
        role: parsedBody?.role,
      });
    }
    throw new ApiError(msg || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export { request, ApiError };
