/**
 * Feishu document writer: create and edit documents using user_access_token.
 * Reuses markdownToBlocks from the sync module.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { withUserAccessToken } from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import { markdownToBlocks, batchBlocks } from '../sync/markdown-to-blocks.js';

const THROTTLE_MS = 300;

export interface DocWriteResult {
  success: boolean;
  documentId?: string;
  url?: string;
  error?: string;
}

export class FeishuDocWriter {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /** Create a new document with Markdown content, using user identity. */
  async createDocument(userToken: string, title: string, markdown: string, folderToken?: string): Promise<DocWriteResult> {
    try {
      // 1. Create empty document
      const createResp = await this.client.docx.v1.document.create(
        { data: { title, folder_token: folderToken } },
        withUserAccessToken(userToken),
      );

      const docId = (createResp.data as any)?.document?.document_id;
      if (!docId) {
        return { success: false, error: 'Failed to create document: no document_id returned' };
      }

      // 2. Write content blocks
      if (markdown.trim()) {
        await this.writeBlocks(userToken, docId, markdown);
      }

      const url = `https://bytedance.larkoffice.com/docx/${docId}`;
      this.logger.info({ docId, title }, 'Document created');
      return { success: true, documentId: docId, url };
    } catch (err: any) {
      const msg = err.response?.data?.msg || err.msg || err.message;
      this.logger.error({ err: msg, title }, 'Failed to create document');
      return { success: false, error: msg };
    }
  }

  /** Replace all content in an existing document. */
  async updateDocument(userToken: string, docId: string, markdown: string): Promise<DocWriteResult> {
    try {
      // 1. Clear existing blocks
      await this.clearBlocks(userToken, docId);

      // 2. Write new blocks
      if (markdown.trim()) {
        await this.writeBlocks(userToken, docId, markdown);
      }

      this.logger.info({ docId }, 'Document updated');
      return { success: true, documentId: docId, url: `https://bytedance.larkoffice.com/docx/${docId}` };
    } catch (err: any) {
      const msg = err.response?.data?.msg || err.msg || err.message;
      this.logger.error({ err: msg, docId }, 'Failed to update document');
      return { success: false, error: msg };
    }
  }

  /** Append Markdown content to the end of a document. */
  async appendToDocument(userToken: string, docId: string, markdown: string): Promise<DocWriteResult> {
    try {
      await this.writeBlocks(userToken, docId, markdown);
      this.logger.info({ docId }, 'Content appended to document');
      return { success: true, documentId: docId, url: `https://bytedance.larkoffice.com/docx/${docId}` };
    } catch (err: any) {
      const msg = err.response?.data?.msg || err.msg || err.message;
      this.logger.error({ err: msg, docId }, 'Failed to append to document');
      return { success: false, error: msg };
    }
  }

  private async writeBlocks(userToken: string, docId: string, markdown: string): Promise<void> {
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) return;

    const batches = batchBlocks(blocks);
    for (const batch of batches) {
      await this.client.docx.v1.documentBlockChildren.create(
        {
          path: { document_id: docId, block_id: docId },
          data: { children: batch, index: -1 },
        },
        withUserAccessToken(userToken),
      );
      await this.throttle();
    }
  }

  private async clearBlocks(userToken: string, docId: string): Promise<void> {
    try {
      const resp = await this.client.docx.v1.documentBlockChildren.get(
        {
          path: { document_id: docId, block_id: docId },
          params: { page_size: 500 },
        },
        withUserAccessToken(userToken),
      );
      const children = (resp.data as any)?.items || [];

      if (children.length > 0) {
        await this.client.docx.v1.documentBlockChildren.batchDelete(
          {
            path: { document_id: docId, block_id: docId },
            data: { start_index: 0, end_index: children.length },
          },
          withUserAccessToken(userToken),
        );
        await this.throttle();
      }
    } catch (err: any) {
      this.logger.warn({ err: err.msg || err.message, docId }, 'Failed to clear blocks, will try writing anyway');
    }
  }

  private throttle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
  }
}
