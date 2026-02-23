import type {
  SyncCombinedRequest,
  SyncCombinedResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '@syncular/core';
import {
  parseSyncCombinedResponse,
  parseSyncPullResponse,
  parseSyncPushResponse,
} from './sync-parse';

export interface JsonActorHeadersOptions {
  actorId: string;
  actorHeader?: string;
  extraHeaders?: Record<string, string>;
}

export function createJsonActorHeaders(
  options: JsonActorHeadersOptions
): Record<string, string> {
  return {
    'content-type': 'application/json',
    [options.actorHeader ?? 'x-actor-id']: options.actorId,
    ...options.extraHeaders,
  };
}

export interface PostJsonWithActorOptions<TBody> {
  fetch: typeof globalThis.fetch;
  url: string;
  actorId: string;
  actorHeader?: string;
  extraHeaders?: Record<string, string>;
  body: TBody;
}

export interface PostJsonWithActorResult<TResponse> {
  response: Response;
  json: TResponse;
}

export async function postJsonWithActor<TBody, TResponse>(
  options: PostJsonWithActorOptions<TBody>
): Promise<PostJsonWithActorResult<TResponse>> {
  const response = await options.fetch(options.url, {
    method: 'POST',
    headers: createJsonActorHeaders({
      actorId: options.actorId,
      actorHeader: options.actorHeader,
      extraHeaders: options.extraHeaders,
    }),
    body: JSON.stringify(options.body),
  });

  const json = (await response.json()) as TResponse;
  return { response, json };
}

export interface PostSyncCombinedRequestOptions {
  fetch: typeof globalThis.fetch;
  url: string;
  actorId: string;
  actorHeader?: string;
  extraHeaders?: Record<string, string>;
  body: SyncCombinedRequest;
}

export async function postSyncCombinedRequest(
  options: PostSyncCombinedRequestOptions
): Promise<PostJsonWithActorResult<SyncCombinedResponse>> {
  const result = await postJsonWithActor<SyncCombinedRequest, unknown>(options);
  return {
    response: result.response,
    json: parseSyncCombinedResponse(result.json),
  };
}

export interface PostSyncPushRequestOptions {
  fetch: typeof globalThis.fetch;
  url: string;
  actorId: string;
  actorHeader?: string;
  extraHeaders?: Record<string, string>;
  body: SyncPushRequest;
}

export async function postSyncPushRequest(
  options: PostSyncPushRequestOptions
): Promise<PostJsonWithActorResult<SyncPushResponse>> {
  const result = await postJsonWithActor<SyncPushRequest, unknown>(options);
  return {
    response: result.response,
    json: parseSyncPushResponse(result.json),
  };
}

export interface PostSyncPullRequestOptions {
  fetch: typeof globalThis.fetch;
  url: string;
  actorId: string;
  actorHeader?: string;
  extraHeaders?: Record<string, string>;
  body: SyncPullRequest;
}

export async function postSyncPullRequest(
  options: PostSyncPullRequestOptions
): Promise<PostJsonWithActorResult<SyncPullResponse>> {
  const result = await postJsonWithActor<SyncPullRequest, unknown>(options);
  return {
    response: result.response,
    json: parseSyncPullResponse(result.json),
  };
}
