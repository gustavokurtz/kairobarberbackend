export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
}
