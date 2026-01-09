/**
 * Storage module exports
 */

// Types
export type {
  Storage,
  StorageFactory,
  StorageChanges,
  SetResult,
  DeleteResult,
} from './types'

// InMemoryStorage (default)
export {
  InMemoryStorage,
  createMemoryStorage,
  clearAllMemoryStorage,
  getMemoryStorageStats,
} from './memory'

// RedisStorage - exported separately via 'krules/storage/redis'
// to keep ioredis as optional dependency
// Use: import { createRedisStorage } from 'krules/storage/redis'
