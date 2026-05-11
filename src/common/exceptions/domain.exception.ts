import { HttpException } from '@nestjs/common';
import { ErrorCode } from './error-codes';

export type DomainExceptionOptions = {
  code: ErrorCode;
  message: string;
  status: number;
  details?: Record<string, unknown>;
};

export class DomainException extends HttpException {
  constructor(public readonly opts: DomainExceptionOptions) {
    super({ code: opts.code, message: opts.message, details: opts.details }, opts.status);
  }
}
