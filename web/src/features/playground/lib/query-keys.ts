/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
export const playgroundQueryKeys = {
  all: ['playground'] as const,
  owner: (userId: number | null) => ['playground', userId] as const,
  list: (userId: number | null) => ['playground', userId, 'sessions'] as const,
  usage: (userId: number | null) => ['playground', userId, 'usage'] as const,
  messageCosts: (userId: number | null, requestIds: string) =>
    ['playground', userId, 'message-costs', requestIds] as const,
  tasks: () => ['playground', 'tasks', 'list'] as const,
  assets: (userId: number | null, kind: string, search: string, page: number) =>
    ['playground-assets', userId, kind, search, page] as const,
  assetsAll: (userId: number | null) => ['playground-assets', userId] as const,
  artifactsAll: (userId: number | null) =>
    ['playground-artifacts', userId] as const,
  detail: (userId: number, id: string) =>
    ['playground', userId, 'session', id] as const,
  messages: (userId: number, id: string) =>
    ['playground', userId, 'session', id, 'messages'] as const,
  artifactList: (userId: number | null, sessionId: string | null) =>
    ['playground-artifacts', userId, sessionId, 'list'] as const,
  artifactDetail: (
    userId: number | null,
    sessionId: string | null,
    artifactId: string | null
  ) =>
    ['playground-artifacts', userId, sessionId, 'detail', artifactId] as const,
  artifactVersions: (
    userId: number | null,
    sessionId: string | null,
    artifactId: string | null
  ) =>
    [
      'playground-artifacts',
      userId,
      sessionId,
      artifactId,
      'versions',
    ] as const,
  artifactVersion: (
    userId: number | null,
    sessionId: string | null,
    artifactId: string | null,
    versionId: string | null
  ) =>
    [
      'playground-artifacts',
      userId,
      sessionId,
      artifactId,
      'version',
      versionId,
    ] as const,
}
