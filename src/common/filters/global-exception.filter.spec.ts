import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './global-exception.filter';
import { DomainException } from '../exceptions/domain.exception';

function makeHost(jsonSpy: jest.Mock, statusSpy: jest.Mock): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ status: statusSpy.mockReturnThis(), json: jsonSpy }),
      getRequest: () => ({ id: 'trace-1', url: '/x', method: 'GET' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let statusSpy: jest.Mock;
  let jsonSpy: jest.Mock;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    statusSpy = jest.fn().mockReturnThis();
    jsonSpy = jest.fn();
  });

  it('maps DomainException to its declared status + code', () => {
    const ex = new DomainException({
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'email taken',
      status: HttpStatus.CONFLICT,
    });
    filter.catch(ex, makeHost(jsonSpy, statusSpy));
    expect(statusSpy).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMAIL_ALREADY_REGISTERED', message: 'email taken' }),
    );
  });

  it('maps unknown error to 500 INTERNAL_ERROR without stack leak', () => {
    filter.catch(new Error('boom'), makeHost(jsonSpy, statusSpy));
    expect(statusSpy).toHaveBeenCalledWith(500);
    const payload = (jsonSpy.mock.calls as { code: string; message: string }[][])[0][0];
    expect(payload.code).toBe('INTERNAL_ERROR');
    expect(payload.message).not.toContain('boom');
  });
});
