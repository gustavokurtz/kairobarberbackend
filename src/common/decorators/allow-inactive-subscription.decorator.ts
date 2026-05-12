import { SetMetadata } from '@nestjs/common';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from 'src/modules/billing/billing.constants';

export const AllowInactiveSubscription = () => SetMetadata(ALLOW_INACTIVE_SUBSCRIPTION_KEY, true);
