import { defineOperationApi } from '@directus/extensions-sdk';
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

function getTokenFromOptions(options: AnyObj): string | null {
  const t = options?.token ?? options?.authToken ?? options?.authorization;
  if (!t) return null;
  return String(t).replace(/^Bearer\s+/i, '').trim() || null;
}

export default defineOperationApi<Options>({
  id: 'emailer',

  handler: async (options: AnyObj, context: AnyObj) => {
    const { services, env, getSchema, logger, accountability } = context;

    const { MailService, AssetsService } = services;

    const schema = await getSchema();

    const mailService = new MailService({
      accountability,
      schema,
    });

    const assetsService = new AssetsService({
      accountability,
      schema,
    });

    const envAny: AnyObj = env || {};
    const allowGuest = normalizeBool(envAny.EMAIL_ALLOW_GUEST_SEND ?? process.env.EMAIL_ALLOW_GUEST_SEND);
    const allowedRoles = splitCsv(envAny.EMAIL_ALLOWED_ROLES ?? process.env.EMAIL_ALLOWED_ROLES);
    const expectedToken = String(envAny.EMAILER_TOKEN ?? process.env.EMAILER_TOKEN ?? '').trim();

    const roles = getAccountabilityRoles(accountability);

    const gotToken = getTokenFromOptions(options);
    const tokenOk = !!expectedToken && !!gotToken && gotToken === expectedToken;

    const info = logger?.info ? (msg: any, label?: string) => logger.info(msg, label) : (msg: any, label?: string) => console.log(label ?? '', msg);
    const error = logger?.error ? (msg: any, label?: string) => logger.error(msg, label) : (msg: any, label?: string) => console.error(label ?? '', msg);

    info(
      {
        EMAIL_ALLOWED_ROLES_ctx: envAny.EMAIL_ALLOWED_ROLES,
        EMAIL_ALLOWED_ROLES_proc: process.env.EMAIL_ALLOWED_ROLES,
        allowGuest,
        allowedRoles,
        admin: !!accountability?.admin,
        role: accountability?.role,
        roles_raw: accountability?.roles,
        roles_normalized: roles,
        tokenOk,
        expectedTokenSet: !!expectedToken,
      },
      '[emailer] auth debug'
    );

    const authorityOk =
      tokenOk ||
      allowGuest ||
      accountability?.admin === true ||
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

      if (Array.isArray(payload.files) && payload.files.length > 0) {
        const fileAttachments = await getAttachments(payload.files);
        mail.attachments = mail.attachments.concat(fileAttachments);
      }

      return mail;
    };

    const emailObject = await createEmailObject(options);

    try {
      await mailService.send(emailObject);
      return 'sent';
    } catch (e: any) {
      error(e, '[emailer] MailService.send error');
      throw e;
    }
  },
});
