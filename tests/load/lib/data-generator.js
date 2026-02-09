/**
 * Test data generators for k6 load tests
 *
 * Provides factory functions for creating test data
 * with various sizes and characteristics.
 */

/**
 * Generate a random string of specified length
 * @param {number} length - Length of the string
 * @returns {string} Random string
 */
export function randomString(length) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a UUID-like string
 * @returns {string} UUID-like identifier
 */
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a random task object
 * @param {string} userId - User ID who owns the task
 * @param {object} [options] - Optional configuration
 * @param {string} [options.id] - Custom task ID
 * @param {string} [options.titleLength] - Title length (default: 20-100)
 * @returns {object} Task operation payload
 */
export function randomTask(userId, options) {
  const opts = options || {};
  const titleLength =
    opts.titleLength || Math.floor(Math.random() * 80) + 20;

  return {
    row_id: opts.id || uuid(),
    payload: {
      title: `Task ${randomString(titleLength)}`,
      completed: Math.random() > 0.7 ? 1 : 0,
      user_id: userId,
    },
  };
}

/**
 * Generate a batch of random tasks
 * @param {string} userId - User ID who owns the tasks
 * @param {number} count - Number of tasks to generate
 * @returns {Array} Array of task operation payloads
 */
export function randomTaskBatch(userId, count) {
  const tasks = [];
  for (let i = 0; i < count; i++) {
    tasks.push(randomTask(userId));
  }
  return tasks;
}

/**
 * Generate a task upsert operation
 * @param {string} userId - User ID who owns the task
 * @param {object} [options] - Optional configuration
 * @returns {object} Sync operation object
 */
export function taskUpsertOperation(userId, options) {
  const task = randomTask(userId, options);
  return {
    scope: 'tasks',
    op: 'upsert',
    table: 'tasks',
    row_id: task.row_id,
    payload: task.payload,
  };
}

/**
 * Generate a task delete operation
 * @param {string} rowId - ID of the task to delete
 * @returns {object} Sync operation object
 */
export function taskDeleteOperation(rowId) {
  return {
    scope: 'tasks',
    op: 'delete',
    table: 'tasks',
    row_id: rowId,
    payload: null,
  };
}

/**
 * Generate user tasks subscription request
 * @param {string} [id] - Subscription ID (default: 'sub-user-tasks')
 * @param {number} [cursor] - Cursor for incremental sync (default: 0)
 * @returns {object} Subscription request object
 */
export function userTasksSubscription(id, cursor) {
  return {
    id: id || 'sub-user-tasks',
    kind: 'user_tasks',
    params: {},
    cursor: cursor || 0,
  };
}

/**
 * Generate a random user ID
 * @param {number} [maxUsers] - Maximum number of unique users (for load distribution)
 * @returns {string} User ID
 */
export function randomUserId(maxUsers) {
  const max = maxUsers || 1000;
  return `user-${Math.floor(Math.random() * max)}`;
}

/**
 * Generate a deterministic user ID based on VU number
 * @param {number} vu - Virtual user number
 * @param {string} [prefix] - Optional prefix (default: 'user')
 * @returns {string} User ID
 */
export function vuUserId(vu, prefix) {
  return `${prefix || 'user'}-${vu}`;
}

/**
 * Generate varied payload sizes for testing different data volumes
 * @param {string} size - Size category: 'small', 'medium', 'large', 'xlarge'
 * @returns {object} Payload with specified size characteristics
 */
export function payloadOfSize(size) {
  const sizes = {
    small: 50, // ~50 bytes
    medium: 500, // ~500 bytes
    large: 5000, // ~5KB
    xlarge: 50000, // ~50KB
  };

  const length = sizes[size] || sizes.medium;
  return {
    data: randomString(length),
  };
}

/**
 * Generate a task with specific payload size
 * @param {string} userId - User ID who owns the task
 * @param {string} size - Size category: 'small', 'medium', 'large', 'xlarge'
 * @returns {object} Task operation with sized payload
 */
export function taskWithSize(userId, size) {
  const payload = payloadOfSize(size);
  return {
    scope: 'tasks',
    op: 'upsert',
    table: 'tasks',
    row_id: uuid(),
    payload: {
      title: `${size} task: ${payload.data.substring(0, 100)}`,
      completed: 0,
      user_id: userId,
    },
  };
}
