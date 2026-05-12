import { AuditAction } from './audit-actions';

export interface AuditRecordInput {
  action: AuditAction | string;
  tenantId?: string | null;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  diff?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditQuery {
  tenantId?: string;
  actorUserId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}
