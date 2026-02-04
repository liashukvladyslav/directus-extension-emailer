import { defineOperationApi } from "@directus/extensions-sdk";

type MaybeArray<T> = T | T[];

export type Options = {
  to: MaybeArray<string>;
  type: "wysiwyg" | "markdown" | "template";
  subject: string;
  body?: string;
  template?: string;
  data?: Record<string, any>;
  cc?: MaybeArray<string>;
  bcc?: MaybeArray<string>;
  replyTo?: MaybeArray<string>;
  from?: string;
  attachments?: any[];
  files?: string | string[];
};

// ...existing code...
export default defineOperationApi<Options>({
  id: "emailer",
  handler: async (options: Options, { env, logger, accountability, getSchema }) => {

    console.log("Executing emailer operation with options:", options);

    // Normalize files to string[]
    let fileIds: string[] = [];
    const rawFiles = options.files;

    if (Array.isArray(rawFiles)) {
      fileIds = rawFiles.map(String).map(s => s.trim()).filter(Boolean);
    } else if (typeof rawFiles === "string") {
      // allow comma-separated string
      fileIds = rawFiles.split(",").map(s => s.trim()).filter(Boolean);
    }

		// Construct payload based on what the endpoint `index.ts` actually consumes
    const endpointPayload: any = {
      to: options.to,
      subject: options.subject,
      cc: options.cc,
      bcc: options.bcc,
      replyTo: options.replyTo,
      from: options.from,
    };

    if (options.type === "template" && options.template) {
      endpointPayload.template = { name: options.template, data: options.data };
    } else if (options.body) {
      endpointPayload.body = options.body;
      endpointPayload.type = options.type;
    }

    if (options.attachments && Array.isArray(options.attachments) && options.attachments.length > 0) {
      endpointPayload.attachments = options.attachments;
    }

    if (fileIds.length > 0) {
      endpointPayload.files = fileIds;
    }

		// Properties like cc, bcc, replyTo are in Options but not handled by the endpoint's `create` function.

    // Remove undefined keys to keep payload clean, though `fetch` handles undefined fine.
    Object.keys(endpointPayload).forEach(
      k => endpointPayload[k] === undefined && delete endpointPayload[k]
    );

    try {
      if (!env.EMAIL_ALLOW_GUEST_SEND && (!accountability || !accountability.user)) {
        logger.warn(
          "No authentication token found for calling the emailer endpoint. Sending may fail if guest sending is not allowed and the operation is not run by an authenticated user."
        );
      }

      logger.info(`Calling emailer function with payload: ${JSON.stringify(endpointPayload)}`);

      const result = await (globalThis as any).Emailer.sendEmail({
        accountability,
        schema: await getSchema(),
        body: endpointPayload,
      });

      if (!result) throw new Error("No result from Emailer.sendEmail");

      logger.info(`Email function responded with: "${result}"`);
      return { success: true };
    } catch (error: any) {
      logger.error("Failed to call emailer function:", error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
});
