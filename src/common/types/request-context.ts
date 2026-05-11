import { UserRole } from '@prisma/client';

export type AuthenticatedUser = {
  id: string;
  role: UserRole;
  tenantId?: string;
};

export type AuthenticatedRequest = {
  user?: AuthenticatedUser;
};
