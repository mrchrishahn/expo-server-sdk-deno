export const REQUEST_RETRY_MIN_TIMEOUT = 1000;

export const BASE_URL = 'https://exp.host';

/**
 * The max number of push notifications to be sent at once. Since we can't automatically upgrade
 * everyone using this library, we should strongly try not to decrease it.
 */
export const PUSH_NOTIFICATION_CHUNK_LIMIT = 100;

/**
 * The max number of push notification receipts to request at once.
 */
export const PUSH_NOTIFICATION_RECEIPT_CHUNK_LIMIT = 300;

/**
 * The default max number of concurrent HTTP requests to send at once and spread out the load,
 * increasing the reliability of notification delivery.
 */
export const DEFAULT_CONCURRENT_REQUEST_LIMIT = 6;
