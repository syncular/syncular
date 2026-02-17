/**
 * @syncular/demo - Client-side patient_notes table handler
 */

import { createClientHandler } from '@syncular/client';
import type { ClientDb } from '../types.generated';

export const patientNotesClientHandler = createClientHandler<
  ClientDb,
  'patient_notes'
>({
  table: 'patient_notes',
  scopes: ['patient:{patient_id}'],
});
