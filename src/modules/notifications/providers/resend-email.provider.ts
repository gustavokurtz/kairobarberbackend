import { Injectable, Logger } from '@nestjs/common';
import type { Resend } from 'resend';
import { EmailMessage, EmailProvider } from '../email.provider';

type ResendLike = Pick<Resend, 'emails'>;

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(
    private readonly client: ResendLike,
    private readonly from: string,
  ) {}

  async send(msg: EmailMessage): Promise<void> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    });
    if (error) {
      this.logger.error(`resend send error to=${msg.to}: ${error.message}`);
      throw new Error(`Resend send failed: ${error.message}`);
    }
    this.logger.debug(`resend send ok id=${data?.id} to=${msg.to}`);
  }
}
