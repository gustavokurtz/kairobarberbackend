import { Injectable, Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from '../email.provider';

@Injectable()
export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(msg: EmailMessage): Promise<void> {
    this.logger.log(`[console-email] to=${msg.to} subject="${msg.subject}"`);
    this.logger.log(`-- body --\n${msg.text}\n--`);

    await Promise.resolve();
  }
}
