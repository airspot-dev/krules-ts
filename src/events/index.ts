/**
 * Built-in event types for krules.ts
 *
 * These events are automatically emitted by the Subject when properties change.
 */

/**
 * Emitted when a subject property value changes.
 * Triggered by Subject.set() and BatchBuilder.commit()
 *
 * EventContext will include:
 * - propertyName: string
 * - oldValue: unknown
 * - newValue: unknown
 */
export const SubjectPropertyChanged = 'subject-property-changed'

/**
 * Emitted when a subject property is deleted.
 * Triggered by Subject.delete() and BatchBuilder.commit()
 *
 * EventContext will include:
 * - propertyName: string
 * - oldValue: unknown
 */
export const SubjectPropertyDeleted = 'subject-property-deleted'

/**
 * Emitted when a subject is completely deleted (flushed).
 * Triggered by Subject.flush()
 *
 * EventContext payload will include:
 * - properties: Record<string, unknown> (snapshot of all properties before deletion)
 */
export const SubjectDeleted = 'subject-deleted'

/**
 * All built-in event types
 */
export const BuiltInEvents = {
  SubjectPropertyChanged,
  SubjectPropertyDeleted,
  SubjectDeleted,
} as const

/**
 * Type helper for event type strings
 */
export type BuiltInEventType = typeof BuiltInEvents[keyof typeof BuiltInEvents]
