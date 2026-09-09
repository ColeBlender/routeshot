import { randomBytes } from 'node:crypto';

/**
 * Report URLs are the only access control on `/r/:id` and `/runs/:id` (a browser loading the
 * report cannot send a bearer token), so ids must be unguessable: 16 random bytes rendered as
 * 22 base64url characters, the same entropy as a v4 UUID without the dashes.
 */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}
