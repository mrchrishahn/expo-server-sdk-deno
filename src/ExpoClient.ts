/**
 * expo-server-sdk
 *
 * Use this if you are running Node on your server backend when you are working with Expo
 * https://expo.io
 */
import promiseLimit from 'https://esm.sh/promise-limit@2.7.0';
import promiseRetry from 'https://esm.sh/promise-retry@2.0.1';
import { gzip } from 'https://deno.land/x/compress@v0.4.4/mod.ts';
import * as Constants from './constants.ts';

const requestRetryMinTimeout = Constants.REQUEST_RETRY_MIN_TIMEOUT;

const BASE_URL = Constants.BASE_URL;
const BASE_API_URL = `${BASE_URL}/--/api/v2`;

export class Expo {
  static pushNotificationChunkSizeLimit = Constants.PUSH_NOTIFICATION_CHUNK_LIMIT;
  static pushNotificationReceiptChunkSizeLimit = Constants.PUSH_NOTIFICATION_RECEIPT_CHUNK_LIMIT;

  private limitConcurrentRequests: <T>(thunk: () => Promise<T>) => Promise<T>;
  private accessToken: string | undefined;

  constructor(options: ExpoClientOptions = {}) {
    this.limitConcurrentRequests = promiseLimit(
      options.maxConcurrentRequests != null
        ? options.maxConcurrentRequests
        : Constants.DEFAULT_CONCURRENT_REQUEST_LIMIT
    );
    this.accessToken = options.accessToken;
  }

  /**
   * Returns `true` if the token is an Expo push token
   */
  static isExpoPushToken(token: unknown): token is ExpoPushToken {
    return (
      typeof token === 'string' &&
      (((token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
        token.endsWith(']')) ||
        /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token))
    );
  }

  /**
   * Sends the given messages to their recipients via push notifications and returns an array of
   * push tickets. Each ticket corresponds to the message at its respective index (the nth receipt
   * is for the nth message) and contains a receipt ID. Later, after Expo attempts to deliver the
   * messages to the underlying push notification services, the receipts with those IDs will be
   * available for a period of time (approximately a day).
   *
   * There is a limit on the number of push notifications you can send at once. Use
   * `chunkPushNotifications` to divide an array of push notification messages into appropriately
   * sized chunks.
   */
  async sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    const actualMessagesCount = Expo._getActualMessageCount(messages);

    const data = await this.limitConcurrentRequests(async () => {
      return await promiseRetry(
        async (retry): Promise<any> => {
          try {
            return await this.requestAsync(`${BASE_API_URL}/push/send`, {
              httpMethod: 'post',
              body: messages,
              shouldCompress(body) {
                return body.length > 1024;
              },
            });
          } catch (e) {
            // if Expo servers rate limit, retry with exponential backoff
            if (e.statusCode === 429) {
              return retry(e);
            }
            throw e;
          }
        },
        {
          retries: 2,
          factor: 2,
          minTimeout: requestRetryMinTimeout,
        }
      );
    });

    if (!Array.isArray(data) || data.length !== actualMessagesCount) {
      const apiError: ExtensibleError = new Error(
        `Expected Expo to respond with ${actualMessagesCount} ${
          actualMessagesCount === 1 ? 'ticket' : 'tickets'
        } but got ${data.length}`
      );
      apiError.data = data;
      throw apiError;
    }

    return data;
  }

  async getPushNotificationReceiptsAsync(
    receiptIds: ExpoPushReceiptId[]
  ): Promise<{ [id: string]: ExpoPushReceipt }> {
    const data = await this.requestAsync(`${BASE_API_URL}/push/getReceipts`, {
      httpMethod: 'post',
      body: { ids: receiptIds },
      shouldCompress(body) {
        return body.length > 1024;
      },
    });

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const apiError: ExtensibleError = new Error(
        `Expected Expo to respond with a map from receipt IDs to receipts but received data of another type`
      );
      apiError.data = data;
      throw apiError;
    }

    return data;
  }

  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    const chunks: ExpoPushMessage[][] = [];
    let chunk: ExpoPushMessage[] = [];

    let chunkMessagesCount = 0;
    for (const message of messages) {
      if (Array.isArray(message.to)) {
        let partialTo: ExpoPushToken[] = [];
        for (const recipient of message.to) {
          partialTo.push(recipient);
          chunkMessagesCount++;
          if (chunkMessagesCount >= Constants.PUSH_NOTIFICATION_CHUNK_LIMIT) {
            // Cap this chunk here if it already exceeds PUSH_NOTIFICATION_CHUNK_LIMIT.
            // Then create a new chunk to continue on the remaining recipients for this message.
            chunk.push({ ...message, to: partialTo });
            chunks.push(chunk);
            chunk = [];
            chunkMessagesCount = 0;
            partialTo = [];
          }
        }
        if (partialTo.length) {
          // Add remaining `partialTo` to the chunk.
          chunk.push({ ...message, to: partialTo });
        }
      } else {
        chunk.push(message);
        chunkMessagesCount++;
      }

      if (chunkMessagesCount >= Constants.PUSH_NOTIFICATION_CHUNK_LIMIT) {
        // Cap this chunk if it exceeds PUSH_NOTIFICATION_CHUNK_LIMIT.
        // Then create a new chunk to continue on the remaining messages.
        chunks.push(chunk);
        chunk = [];
        chunkMessagesCount = 0;
      }
    }
    if (chunkMessagesCount) {
      // Add the remaining chunk to the chunks.
      chunks.push(chunk);
    }

    return chunks;
  }

  chunkPushNotificationReceiptIds(receiptIds: ExpoPushReceiptId[]): ExpoPushReceiptId[][] {
    return this.chunkItems(receiptIds, Constants.PUSH_NOTIFICATION_RECEIPT_CHUNK_LIMIT);
  }

  private chunkItems<T>(items: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    let chunk: T[] = [];
    for (const item of items) {
      chunk.push(item);
      if (chunk.length >= chunkSize) {
        chunks.push(chunk);
        chunk = [];
      }
    }

    if (chunk.length) {
      chunks.push(chunk);
    }

    return chunks;
  }

  private async requestAsync(url: string, options: RequestOptions): Promise<any> {
    let requestBody: string | ArrayBuffer | undefined;

    const sdkVersion = '3.7.0'; // TODO: make this reflect the version identified in Deno.jsonc
    const requestHeaders = new Headers({
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': `expo-server-sdk-deno/${sdkVersion}`,
    });
    if (this.accessToken) {
      requestHeaders.set('Authorization', `Bearer ${this.accessToken}`);
    }

    if (options.body != null) {
      const json = JSON.stringify(options.body);
      if (json == null) {
        throw Error('JSON request body must not be null')
      }
      if (options.shouldCompress(json)) {
        const data = new TextEncoder().encode(json);
        requestBody = gzip(data);
        requestHeaders.set('Content-Encoding', 'gzip');
      } else {
        requestBody = json;
      }

      requestHeaders.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      method: options.httpMethod,
      body: requestBody,
      headers: requestHeaders,
    });

    if (response.status !== 200) {
      const apiError = await this.parseErrorResponseAsync(response);
      throw apiError;
    }

    const textBody = await response.text();
    // We expect the API response body to be JSON
    let result: ApiResult;
    try {
      result = JSON.parse(textBody);
    } catch (_e) {
      const apiError = this.getTextResponseError(response, textBody);
      throw apiError;
    }

    if (result.errors) {
      const apiError = this.getErrorFromResult(response, result);
      throw apiError;
    }

    return result.data;
  }

  private async parseErrorResponseAsync(response: Response): Promise<Error> {
    const textBody = await response.text();
    let result: ApiResult;
    try {
      result = JSON.parse(textBody);
    } catch (_e) {
      return this.getTextResponseError(response, textBody);
    }

    if (!result.errors || !Array.isArray(result.errors) || !result.errors.length) {
      const apiError: ExtensibleError = this.getTextResponseError(response, textBody);
      apiError.errorData = result;
      return apiError;
    }

    return this.getErrorFromResult(response, result);
  }

  private getTextResponseError(response: Response, text: string): Error {
    const apiError: ExtensibleError = new Error(
      `Expo responded with an error with status code ${response.status}: ` + text
    );
    apiError.statusCode = response.status;
    apiError.errorText = text;
    return apiError;
  }

  /**
   * Returns an error for the first API error in the result, with an optional `others` field that
   * contains any other errors.
   */
  private getErrorFromResult(response: Response, result: ApiResult): Error {
    if (!result.errors || !Array.isArray(result.errors) || !result.errors.length) {
      throw new Error('Expected at least one error from Expo');
    }
    const [errorData, ...otherErrorData] = result.errors!;
    const error: ExtensibleError = this.getErrorFromResultError(errorData);
    if (otherErrorData.length) {
      error.others = otherErrorData.map((data) => this.getErrorFromResultError(data));
    }
    error.statusCode = response.status;
    return error;
  }

  /**
   * Returns an error for a single API error
   */
  private getErrorFromResultError(errorData: ApiResultError): Error {
    const error: ExtensibleError = new Error(errorData.message);
    error.code = errorData.code;

    if (errorData.details != null) {
      error.details = errorData.details;
    }

    if (errorData.stack != null) {
      error.serverStack = errorData.stack;
    }

    return error;
  }

  static _getActualMessageCount(messages: ExpoPushMessage[]): number {
    return messages.reduce((total, message) => {
      if (Array.isArray(message.to)) {
        total += message.to.length;
      } else {
        total++;
      }
      return total;
    }, 0);
  }
}

export default Expo;

export type ExpoClientOptions = {
  maxConcurrentRequests?: number;
  accessToken?: string;
};

export type ExpoPushToken = string;

type ExpoPushMessageDetailsObject = Record<string | number | symbol, unknown>;

export type ExpoPushMessage = {
  to: ExpoPushToken | ExpoPushToken[];
  data?: ExpoPushMessageDetailsObject;
  title?: string;
  subtitle?: string;
  body?: string;
  sound?:
    | 'default'
    | null
    | {
        critical?: boolean;
        name?: 'default' | null;
        volume?: number;
      };
  ttl?: number;
  expiration?: number;
  priority?: 'default' | 'normal' | 'high';
  badge?: number;
  channelId?: string;
  categoryId?: string;
  mutableContent?: boolean;
};

export type ExpoPushReceiptId = string;

export type ExpoPushSuccessTicket = {
  status: 'ok';
  id: ExpoPushReceiptId;
};

export type ExpoPushErrorTicket = ExpoPushErrorReceipt;

export type ExpoPushTicket = ExpoPushSuccessTicket | ExpoPushErrorTicket;

export type ExpoPushSuccessReceipt = {
  status: 'ok';
  details?: ExpoPushMessageDetailsObject;
  // Internal field used only by developers working on Expo
  __debug?: unknown;
};

export type ExpoPushErrorReceipt = {
  status: 'error';
  message: string;
  details?: {
    error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded';
  };
  // Internal field used only by developers working on Expo
  __debug?: unknown;
};

export type ExpoPushReceipt = ExpoPushSuccessReceipt | ExpoPushErrorReceipt;

type RequestOptions = {
  httpMethod: 'get' | 'post';
  body?: any;
  shouldCompress: (body: string) => boolean;
};

type ApiResult = {
  errors?: ApiResultError[];
  data?: any;
};

type ApiResultError = {
  message: string;
  code: string;
  details?: any;
  stack?: string;
};

class ExtensibleError extends Error {
  [key: string]: any;
}
