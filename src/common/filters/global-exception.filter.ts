import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCodes } from '../exceptions/error-codes';

interface TracedRequest {
  id?: string;
  method?: string;
  url?: string;
}

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<TracedRequest>();
    const traceId = req.id;

    if (exception instanceof DomainException) {
      const { code, message, details, status } = exception.opts;
      const body: ErrorEnvelope = { code, message, details, traceId };
      return res.status(status).json(body);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const isObj = typeof responseBody === 'object' && responseBody !== null;
      const rawMessage = isObj
        ? ((responseBody as { message?: string | string[] }).message ?? exception.message)
        : responseBody;
      const code = this.mapHttpStatusToCode(status);
      const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : rawMessage;
      const body: ErrorEnvelope = { code, message, traceId };
      return res.status(status).json(body);
    }

    this.logger.error(
      `Unhandled exception at ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    const body: ErrorEnvelope = {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Erro interno. Tente novamente em instantes.',
      traceId,
    };
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  private mapHttpStatusToCode(status: number): string {
    switch (status) {
      case 400:
        return ErrorCodes.VALIDATION_ERROR;
      case 401:
        return ErrorCodes.UNAUTHENTICATED;
      case 403:
        return ErrorCodes.FORBIDDEN;
      case 404:
        return ErrorCodes.NOT_FOUND;
      case 409:
        return ErrorCodes.CONFLICT;
      default:
        return ErrorCodes.INTERNAL_ERROR;
    }
  }
}
