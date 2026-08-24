import { config } from '../config.js';
import { MemoryStore } from './memoryStore.js';
import { RedisStore } from './redisStore.js';

/** store 工厂：按 STORE_MODE 返回统一接口的实现 */
export function createStore() {
  if (config.storeMode === 'redis') {
    return new RedisStore({ redisUrl: config.redisUrl, maxMembers: config.room.maxMembers });
  }
  return new MemoryStore({ maxMembers: config.room.maxMembers });
}
