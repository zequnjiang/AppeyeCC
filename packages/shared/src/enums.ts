import { z } from 'zod';

/** 应用商店 */
export const StoreSchema = z.enum(['gp', 'ios']);
export type Store = z.infer<typeof StoreSchema>;

/** 变更事件类型（「新发现」页面数据源） */
export const EventTypeSchema = z.enum([
  'new_app',
  'version_update',
  'description_change',
  'release_notes_change',
  'permissions_change',
  'privacy_change',
  'developer_change',
  'metadata_change',
  'removed',
  'reappeared',
  'classified_loan',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** 应用在库中的状态 */
export const AppStatusSchema = z.enum(['active', 'removed']);
export type AppStatus = z.infer<typeof AppStatusSchema>;
