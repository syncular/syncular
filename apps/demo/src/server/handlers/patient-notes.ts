/**
 * @syncular/demo - Server-side patient_notes table handler
 *
 * Scope: patient:{patient_id}
 *
 * Notes:
 * - Any authenticated actor can read/write notes for any patient
 * - This demo focuses on E2EE encryption, not access control
 * - In production, access control would be enforced server-side
 */

import type { EmittedChange } from '@syncular/server';
import { createServerHandler } from '@syncular/server';
import { sql } from 'kysely';
import type { ClientDb } from '../../client/types.generated';
import type { ServerDb } from '../db';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const patientNotesServerHandler = createServerHandler<
  ServerDb,
  ClientDb,
  'patient_notes'
>({
  table: 'patient_notes',
  scopes: ['patient:{patient_id}'],
  resolveScopes: async () => ({
    // Any authenticated actor can access any patient's notes
    // In production, this would filter based on actor's permissions
    patient_id: '*',
  }),
  // Custom applyOperation for created_by/created_at on insert and cannot-move-between-patients
  applyOperation: async (ctx, op, opIndex) => {
    if (op.table !== 'patient_notes') {
      return {
        result: {
          opIndex,
          status: 'error',
          error: `UNKNOWN_TABLE:${op.table}`,
          code: 'UNKNOWN_TABLE',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    // Handle delete
    if (op.op === 'delete') {
      const existingResult = await sql<{ id: string; patient_id: string }>`
        select ${sql.ref('id')}, ${sql.ref('patient_id')}
        from ${sql.table('patient_notes')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
        limit ${sql.val(1)}
      `.execute(ctx.trx);
      const existing = existingResult.rows[0];

      if (!existing) {
        return { result: { opIndex, status: 'applied' }, emittedChanges: [] };
      }

      await sql`
        delete from ${sql.table('patient_notes')}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);

      const emitted: EmittedChange = {
        table: 'patient_notes',
        row_id: op.row_id,
        op: 'delete',
        row_json: null,
        row_version: null,
        scopes: { patient_id: existing.patient_id },
      };

      return {
        result: { opIndex, status: 'applied' },
        emittedChanges: [emitted],
      };
    }

    // Handle upsert
    const payload = isRecord(op.payload) ? op.payload : {};
    const payloadNote =
      typeof payload.note === 'string' ? payload.note : undefined;
    const payloadPatientId =
      typeof payload.patient_id === 'string' ? payload.patient_id : undefined;
    const payloadCreatedBy =
      typeof payload.created_by === 'string' ? payload.created_by : undefined;
    const payloadCreatedAt =
      typeof payload.created_at === 'string' ? payload.created_at : undefined;

    const existingResult = await sql<{
      id: string;
      patient_id: string;
      note: string;
      created_by: string;
      created_at: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('patient_id')},
        ${sql.ref('note')},
        ${sql.ref('created_by')},
        ${sql.ref('created_at')},
        ${sql.ref('server_version')}
      from ${sql.table('patient_notes')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const existing = existingResult.rows[0];

    // Version conflict check
    if (
      existing &&
      op.base_version != null &&
      existing.server_version !== op.base_version
    ) {
      return {
        result: {
          opIndex,
          status: 'conflict',
          message: `Version conflict: server=${existing.server_version}, base=${op.base_version}`,
          server_version: existing.server_version,
          server_row: existing,
        },
        emittedChanges: [],
      };
    }

    const patientId = payloadPatientId ?? existing?.patient_id;
    if (!patientId) {
      return {
        result: {
          opIndex,
          status: 'error',
          error: 'MISSING_PATIENT_ID',
          code: 'INVALID_REQUEST',
          retriable: false,
        },
        emittedChanges: [],
      };
    }

    if (existing) {
      // Cannot move between patients
      if (payloadPatientId && payloadPatientId !== existing.patient_id) {
        return {
          result: {
            opIndex,
            status: 'error',
            error: 'CANNOT_MOVE_BETWEEN_PATIENTS',
            code: 'INVALID_REQUEST',
            retriable: false,
          },
          emittedChanges: [],
        };
      }

      await sql`
        update ${sql.table('patient_notes')}
        set
          ${sql.ref('note')} = ${sql.val(payloadNote ?? existing.note)},
          ${sql.ref('server_version')} = ${sql.val(existing.server_version + 1)}
        where ${sql.ref('id')} = ${sql.val(op.row_id)}
      `.execute(ctx.trx);
    } else {
      // Insert - set created_by and created_at
      await sql`
        insert into ${sql.table('patient_notes')} (
          ${sql.join([
            sql.ref('id'),
            sql.ref('patient_id'),
            sql.ref('note'),
            sql.ref('created_by'),
            sql.ref('created_at'),
            sql.ref('server_version'),
          ])}
        ) values (
          ${sql.join([
            sql.val(op.row_id),
            sql.val(patientId),
            sql.val(payloadNote ?? ''),
            sql.val(payloadCreatedBy ?? ctx.actorId),
            sql.val(payloadCreatedAt ?? new Date().toISOString()),
            sql.val(1),
          ])}
        )
      `.execute(ctx.trx);
    }

    const updatedResult = await sql<{
      id: string;
      patient_id: string;
      note: string;
      created_by: string;
      created_at: string;
      server_version: number;
    }>`
      select
        ${sql.ref('id')},
        ${sql.ref('patient_id')},
        ${sql.ref('note')},
        ${sql.ref('created_by')},
        ${sql.ref('created_at')},
        ${sql.ref('server_version')}
      from ${sql.table('patient_notes')}
      where ${sql.ref('id')} = ${sql.val(op.row_id)}
      limit ${sql.val(1)}
    `.execute(ctx.trx);
    const updated = updatedResult.rows[0];
    if (!updated) throw new Error(`Missing patient_note row: ${op.row_id}`);

    const emitted: EmittedChange = {
      table: 'patient_notes',
      row_id: op.row_id,
      op: 'upsert',
      row_json: updated,
      row_version: updated.server_version ?? 1,
      scopes: { patient_id: updated.patient_id },
    };

    return {
      result: { opIndex, status: 'applied' },
      emittedChanges: [emitted],
    };
  },
});
