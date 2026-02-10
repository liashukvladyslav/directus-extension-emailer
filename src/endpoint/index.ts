import type { OperationApiConfig } from '@directus/extensions';
import { md } from '../utils/md';
import type { MailMessage, Options } from '../utils/_types';

type AnyObj = Record<string, any>;

function normalizeBool(v: any): boolean {
  return v === true || String(v).toLowerCase() === 'true';
}

function splitCsv(v: any): string[] {
  return String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getAccountabilityRoles(acc: AnyObj | undefined): string[] {
  if (!acc) return [];
  const rolesArr = Array.isArray(acc.roles) ? acc.roles.map(String) : [];
  const roleSingle = acc.role != null ? [String(acc.role)] : [];
  return Array.from(new Set([...rolesArr, ...roleSingle]));
}

function getTokenFromHeaders(req: any): string | null {
  const auth = req?.headers?.authorization;
  const x = req?.headers?.['x-emailer-token'];
  const raw = (auth || x) ?? '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

const config: OperationApiConfig<Options> = {
  id: 'emailer',
  handler: (router, { services, env }) => {
    const { AssetsService, MailService } = services;

    (globalThis as any).Emailer = {
      sendEmail: async (context: AnyObj) => {
        const acc: AnyObj | undefined = context.accountability;
        const schema = context.schema;

        const mailService = new MailService({ accountability: acc, schema });
        const assetsService = new AssetsService({ accountability: acc, schema });

        const emailPayload = context.body;

        const allowGuest = normalizeBool(env.EMAIL_ALLOW_GUEST_SEND);
        const allowedRoles = splitCsv(env.EMAIL_ALLOWED_ROLES);
        const roles = getAccountabilityRoles(acc);

        const expectedToken = String(env.EMAILER_TOKEN ?? '').trim();
        const gotToken = context?.token ? String(context.token).trim() : '';
        const tokenOk = !!expectedToken && !!gotToken && gotToken === expectedToken;

        const authorityOk =
          tokenOk ||
          allowGuest ||
          acc?.admin === true ||
          (allowedRoles.length > 0 && roles.some((r) => allowedRoles.includes(r)));

        if (!authorityOk) {
          throw new Error('User not authorized, enable guest sending or include a token');
        }

        const getAttachments = async (fileIDs: any): Promise<any[]> => {
          const ids = Array.isArray(fileIDs) ? fileIDs : [];
          if (ids.length === 0) return [];

          const settled = await Promise.allSettled(
            ids.map((id) => assetsService.getAsset(id, { transformationParams: {} }))
          );

          const ok = settled.filter((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>[];

          return ok.map((asset) => {
            const { stream, file } = asset.value;
            return {
              contentType: file.type,
              filename: file.filename_download,
              content: stream,
            };
          });
        };

        const createEmailObject = async (payload: AnyObj): Promise<MailMessage> => {
          const mail: MailMessage = {
            to: payload.to,
            subject: payload.subject,
            attachments: payload.attachments || [],
          };

          if (payload.from) mail.from = payload.from;
          if (payload.cc) mail.cc = payload.cc;
          if (payload.bcc) mail.bcc = payload.bcc;
          if (payload.replyTo) mail.replyTo = payload.replyTo;

          const safeBody = typeof payload.body !== 'string' ? JSON.stringify(payload.body) : payload.body;

          if (payload.type === 'template') {
            mail.template = {
              name: payload.template || 'base',
              data: payload.data || {},
            };
          } else {
            mail.html = payload.type === 'wysiwyg' ? safeBody : md(safeBody);
          }

          if (!Array.isArray(mail.attachments)) mail.attachments = [];

          if (payload.files != null && Array.isArray(payload.files) && payload.files.length > 0) {
            const fileAttachments = await getAttachments(payload.files);
            mail.attachments = mail.attachments.concat(fileAttachments);
          }

          return mail;
        };

        const emailObject = await createEmailObject(emailPayload);
        await mailService.send(emailObject);

        return 'sent';
      },
    };

    router.post('/', async (req, res) => {
      const accountability = req.accountability || { user: null, role: null };
      const token = getTokenFromHeaders(req);

      const context = {
        accountability,
        schema: req.schema,
        body: req.body,
        token,
      };

      try {
        const result = await (globalThis as any).Emailer.sendEmail(context);
        return res.send({ message: 'Email processed successfully', status: result });
      } catch (error: any) {
        console.error('[emailer:endpoint] ERROR:', error);
        const msg = error instanceof Error ? error.message : String(error);
        const status = msg.includes('User not authorized') ? 401 : 500;
        return res.status(status).send({ message: 'Failed to send email', error: msg });
      }
    });
  },
};

export default config;
