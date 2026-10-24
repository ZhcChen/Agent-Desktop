import { APP_SERVER_ERROR_CODES, type AppServerErrorCode } from './constants.js';

export interface ServiceErrorPayload {
  code: AppServerErrorCode | number;
  message: string;
  data?: unknown;
}

/** 带错误码的协议异常。运行时与客户端共用。 */
export class ServiceError extends Error {
  readonly code: AppServerErrorCode | number;
  readonly data?: unknown;

  constructor(code: AppServerErrorCode | number, message: string, data?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  static methodNotFound(method: string): ServiceError {
    return new ServiceError(APP_SERVER_ERROR_CODES.methodNotFound, `Unknown method: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): ServiceError {
    return new ServiceError(APP_SERVER_ERROR_CODES.invalidParams, message, data);
  }

  static internal(message: string, data?: unknown): ServiceError {
    return new ServiceError(APP_SERVER_ERROR_CODES.internalError, message, data);
  }

  static agentUnavailable(agentId: string, detail?: string): ServiceError {
    return new ServiceError(
      APP_SERVER_ERROR_CODES.agentUnavailable,
      `Agent is not available: ${agentId}${detail ? ` (${detail})` : ''}`,
    );
  }

  static sessionNotFound(sessionId: string): ServiceError {
    return new ServiceError(
      APP_SERVER_ERROR_CODES.sessionNotFound,
      `Session not found: ${sessionId}`,
    );
  }

  toPayload(): ServiceErrorPayload {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function toServiceErrorPayload(error: unknown): ServiceErrorPayload {
  if (error instanceof ServiceError) return error.toPayload();
  const message = error instanceof Error ? error.message : String(error);
  return { code: APP_SERVER_ERROR_CODES.internalError, message };
}
