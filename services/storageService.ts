import { ProjectState, AssetLibraryItem, SeriesProject, Series, Episode } from '../types';
import { materializeProjectVideosForExport } from './videoStorageService';
import { sanitizePromptTemplateOverrides } from './promptTemplateService';

const CLOUD_STORE_BASE = '/api/config/storage';
const REQUEST_TIMEOUT_MS = 90000;
const EXPORT_SCHEMA_VERSION = 3;
const DB_NAME = 'CloudConfigStore';
const DB_VERSION = 1;

type CloudBucket = 'seriesProjects' | 'series' | 'episodes' | 'assetLibrary';

export interface IndexedDBExportPayload {
  schemaVersion: number;
  exportedAt: number;
  scope?: 'all' | 'project' | 'episode';
  dbName: string;
  dbVersion: number;
  stores: {
    projects: ProjectState[];
    assetLibrary: AssetLibraryItem[];
    seriesProjects?: SeriesProject[];
    series?: Series[];
    episodes?: Episode[];
  };
}

const withTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Cloud storage request timed out (${REQUEST_TIMEOUT_MS}ms)`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const parseJsonResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // no-op
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

const listBucket = async <T>(bucket: CloudBucket, field?: string, value?: string): Promise<T[]> => {
  const params = new URLSearchParams();
  if (field && value) {
    params.set('field', field);
    params.set('value', value);
  }
  const query = params.toString();
  const response = await withTimeout(`${CLOUD_STORE_BASE}/${bucket}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = await parseJsonResponse<{ items: T[] }>(response);
  return Array.isArray(payload.items) ? payload.items : [];
};

const getById = async <T>(bucket: CloudBucket, id: string): Promise<T> => {
  const response = await withTimeout(`${CLOUD_STORE_BASE}/${bucket}/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = await parseJsonResponse<{ item: T }>(response);
  return payload.item;
};

const putById = async <T extends { id: string }>(bucket: CloudBucket, item: T): Promise<void> => {
  const response = await withTimeout(`${CLOUD_STORE_BASE}/${bucket}/${encodeURIComponent(item.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  await parseJsonResponse<{ item: T }>(response);
};

const deleteById = async (bucket: CloudBucket, id: string): Promise<void> => {
  const response = await withTimeout(`${CLOUD_STORE_BASE}/${bucket}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  await parseJsonResponse<{ ok: boolean }>(response);
};

const batchUpsert = async <T extends { id: string }>(bucket: CloudBucket, items: T[]): Promise<void> => {
  if (!items.length) return;
  const response = await withTimeout(`${CLOUD_STORE_BASE}/batch-upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, items }),
  });
  await parseJsonResponse<{ ok: boolean }>(response);
};

const batchDelete = async (bucket: CloudBucket, ids: string[]): Promise<void> => {
  if (!ids.length) return;
  const response = await withTimeout(`${CLOUD_STORE_BASE}/batch-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucket, ids }),
  });
  await parseJsonResponse<{ ok: boolean }>(response);
};

const mergeByKey = <T>(
  existing: T[] | undefined,
  inferred: T[],
  getKey: (item: T) => string
): T[] => {
  const merged = new Map<string, T>();
  inferred.forEach(item => merged.set(getKey(item), item));
  (existing || []).forEach(item => merged.set(getKey(item), item));
  return Array.from(merged.values());
};

const normalizeEpisode = (ep: Episode): Episode => {
  const scriptData = ep.scriptData
    ? {
        ...ep.scriptData,
        props: ep.scriptData.props || [],
      }
    : null;

  const inferredCharacterRefs = (scriptData?.characters || [])
    .filter(c => !!c.libraryId)
    .map(c => ({
      characterId: c.libraryId!,
      syncedVersion: c.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredSceneRefs = (scriptData?.scenes || [])
    .filter(s => !!s.libraryId)
    .map(s => ({
      sceneId: s.libraryId!,
      syncedVersion: s.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  const inferredPropRefs = (scriptData?.props || [])
    .filter(p => !!p.libraryId)
    .map(p => ({
      propId: p.libraryId!,
      syncedVersion: p.libraryVersion || 1,
      syncStatus: 'synced' as const,
    }));

  return {
    ...ep,
    scriptData,
    renderLogs: ep.renderLogs || [],
    characterRefs: mergeByKey(ep.characterRefs, inferredCharacterRefs, r => r.characterId),
    sceneRefs: mergeByKey(ep.sceneRefs, inferredSceneRefs, r => r.sceneId),
    propRefs: mergeByKey(ep.propRefs, inferredPropRefs, r => r.propId),
    promptTemplateOverrides: sanitizePromptTemplateOverrides(ep.promptTemplateOverrides),
  };
};

// =============================================
// SeriesProject CRUD
// =============================================

export const saveSeriesProject = async (sp: SeriesProject): Promise<void> => {
  await putById('seriesProjects', { ...sp, lastModified: Date.now() });
};

export const loadSeriesProject = async (id: string): Promise<SeriesProject> => {
  return getById<SeriesProject>('seriesProjects', id);
};

export const getAllSeriesProjects = async (): Promise<SeriesProject[]> => {
  const items = await listBucket<SeriesProject>('seriesProjects');
  items.sort((a, b) => b.lastModified - a.lastModified);
  return items;
};

export const deleteSeriesProject = async (id: string): Promise<void> => {
  const [seriesList, episodes] = await Promise.all([
    getSeriesByProject(id),
    getEpisodesByProject(id),
  ]);

  await Promise.all([
    batchDelete('series', seriesList.map(s => s.id)),
    batchDelete('episodes', episodes.map(ep => ep.id)),
    deleteById('seriesProjects', id),
  ]);
};

export const createNewSeriesProject = (title?: string): SeriesProject => {
  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timePart = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const autoTitle = `新建项目 ${datePart} ${timePart}`;
  const finalTitle = title?.trim() || autoTitle;

  return {
    id: 'sproj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: finalTitle,
    createdAt: Date.now(),
    lastModified: Date.now(),
    visualStyle: '3d-animation',
    language: '中文',
    characterLibrary: [],
    sceneLibrary: [],
    propLibrary: [],
  };
};

// =============================================
// Series CRUD
// =============================================

export const saveSeries = async (s: Series): Promise<void> => {
  await putById('series', { ...s, lastModified: Date.now() });
};

export const getSeriesByProject = async (projectId: string): Promise<Series[]> => {
  const items = await listBucket<Series>('series', 'projectId', projectId);
  items.sort((a, b) => a.sortOrder - b.sortOrder);
  return items;
};

export const deleteSeries = async (id: string): Promise<void> => {
  const episodes = await getEpisodesBySeries(id);
  await Promise.all([
    batchDelete('episodes', episodes.map(ep => ep.id)),
    deleteById('series', id),
  ]);
};

export const createNewSeries = (projectId: string, title: string, sortOrder: number): Series => {
  return {
    id: 'series_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    title,
    sortOrder,
    createdAt: Date.now(),
    lastModified: Date.now(),
  };
};

// =============================================
// Episode CRUD
// =============================================

export const saveEpisode = async (ep: Episode): Promise<void> => {
  const normalized = normalizeEpisode(ep);
  await putById('episodes', { ...normalized, lastModified: Date.now() });
};

export const loadEpisode = async (id: string): Promise<Episode> => {
  const episode = await getById<Episode>('episodes', id);
  return normalizeEpisode(episode);
};

export const getEpisodesByProject = async (projectId: string): Promise<Episode[]> => {
  const items = await listBucket<Episode>('episodes', 'projectId', projectId);
  const normalized = items.map(normalizeEpisode);
  normalized.sort((a, b) => a.episodeNumber - b.episodeNumber);
  return normalized;
};

export const getEpisodesBySeries = async (seriesId: string): Promise<Episode[]> => {
  const items = await listBucket<Episode>('episodes', 'seriesId', seriesId);
  const normalized = items.map(normalizeEpisode);
  normalized.sort((a, b) => a.episodeNumber - b.episodeNumber);
  return normalized;
};

export const deleteEpisode = async (id: string): Promise<void> => {
  await deleteById('episodes', id);
};

export const createNewEpisode = (projectId: string, seriesId: string, episodeNumber: number, title?: string): Episode => {
  return {
    id: 'ep_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    projectId,
    seriesId,
    episodeNumber,
    title: title || `第 ${episodeNumber} 集`,
    createdAt: Date.now(),
    lastModified: Date.now(),
    stage: 'script',
    rawScript: '',
    targetDuration: '60s',
    language: '中文',
    visualStyle: '3d-animation',
    shotGenerationModel: 'gpt-5.2',
    scriptData: null,
    shots: [],
    isParsingScript: false,
    renderLogs: [],
    characterRefs: [],
    sceneRefs: [],
    propRefs: [],
    promptTemplateOverrides: undefined,
    scriptGenerationCheckpoint: null,
  };
};

// =============================================
// Legacy ProjectState compat (episodes store)
// =============================================

export const saveProjectToDB = async (project: ProjectState): Promise<void> => {
  return saveEpisode(project);
};

export const loadProjectFromDB = async (id: string): Promise<ProjectState> => {
  return loadEpisode(id);
};

export const getAllProjectsMetadata = async (): Promise<ProjectState[]> => {
  const episodes = (await listBucket<Episode>('episodes')).map(normalizeEpisode);
  episodes.sort((a, b) => b.lastModified - a.lastModified);
  return episodes;
};

export const deleteProjectFromDB = async (id: string): Promise<void> => {
  return deleteEpisode(id);
};

export const createNewProjectState = (): ProjectState => {
  return createNewEpisode('', '', 1, '未命名项目');
};

// =============================================
// Asset Library Operations
// =============================================

export const saveAssetToLibrary = async (item: AssetLibraryItem): Promise<void> => {
  await putById('assetLibrary', item);
};

export const getAllAssetLibraryItems = async (): Promise<AssetLibraryItem[]> => {
  const items = await listBucket<AssetLibraryItem>('assetLibrary');
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
};

export const deleteAssetFromLibrary = async (id: string): Promise<void> => {
  await deleteById('assetLibrary', id);
};

// =============================================
// Export / Import
// =============================================

export const exportIndexedDBData = async (): Promise<IndexedDBExportPayload> => {
  const [assetLibrary, seriesProjects, series, episodesRaw] = await Promise.all([
    getAllAssetLibraryItems(),
    getAllSeriesProjects(),
    listBucket<Series>('series'),
    listBucket<Episode>('episodes'),
  ]);

  const episodes = episodesRaw.map(normalizeEpisode);
  const portableEpisodes = await Promise.all(
    episodes.map(ep => materializeProjectVideosForExport(ep))
  );

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    scope: 'all',
    dbName: DB_NAME,
    dbVersion: DB_VERSION,
    stores: {
      projects: [],
      assetLibrary,
      seriesProjects,
      series,
      episodes: portableEpisodes as Episode[],
    },
  };
};

export const exportProjectData = async (project: ProjectState): Promise<IndexedDBExportPayload> => {
  const portableProject = await materializeProjectVideosForExport(project);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    scope: 'episode',
    dbName: DB_NAME,
    dbVersion: DB_VERSION,
    stores: {
      projects: [portableProject],
      assetLibrary: [],
    },
  };
};

export const exportSeriesProjectData = async (projectId: string): Promise<IndexedDBExportPayload> => {
  const [seriesProject, series, episodesRaw] = await Promise.all([
    loadSeriesProject(projectId),
    getSeriesByProject(projectId),
    getEpisodesByProject(projectId),
  ]);

  const portableEpisodes = await Promise.all(
    episodesRaw.map(ep => materializeProjectVideosForExport(ep))
  );

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    scope: 'project',
    dbName: DB_NAME,
    dbVersion: DB_VERSION,
    stores: {
      projects: [],
      assetLibrary: [],
      seriesProjects: [seriesProject],
      series,
      episodes: portableEpisodes as Episode[],
    },
  };
};

const isValidExportPayload = (data: unknown): data is IndexedDBExportPayload => {
  const p = data as IndexedDBExportPayload;
  return !!(p && p.stores);
};

export const importIndexedDBData = async (
  payload: unknown,
  options?: { mode?: 'merge' | 'replace' }
): Promise<{ projects: number; assets: number }> => {
  if (!isValidExportPayload(payload)) throw new Error('导入文件格式不正确');

  const mode = options?.mode || 'merge';
  const importedEpisodes = ((payload.stores.episodes || []) as Episode[]).map(ep => normalizeEpisode(ep));

  if (mode === 'replace') {
    const [asset, sps, ss, eps] = await Promise.all([
      listBucket<{ id: string }>('assetLibrary'),
      listBucket<{ id: string }>('seriesProjects'),
      listBucket<{ id: string }>('series'),
      listBucket<{ id: string }>('episodes'),
    ]);
    await Promise.all([
      batchDelete('assetLibrary', asset.map(i => i.id)),
      batchDelete('seriesProjects', sps.map(i => i.id)),
      batchDelete('series', ss.map(i => i.id)),
      batchDelete('episodes', eps.map(i => i.id)),
    ]);
  }

  let count = 0;

  const assets = payload.stores.assetLibrary || [];
  const seriesProjects = payload.stores.seriesProjects || [];
  const series = payload.stores.series || [];

  await Promise.all([
    (async () => {
      await batchUpsert('assetLibrary', assets);
      count += assets.length;
    })(),
    (async () => {
      await batchUpsert('seriesProjects', seriesProjects);
      count += seriesProjects.length;
    })(),
    (async () => {
      await batchUpsert('series', series);
      count += series.length;
    })(),
    (async () => {
      await batchUpsert('episodes', importedEpisodes);
      count += importedEpisodes.length;
    })(),
  ]);

  if (payload.stores.projects && payload.stores.projects.length > 0 && !(payload.stores.episodes && payload.stores.episodes.length > 0)) {
    const generatedSeriesProjects: SeriesProject[] = [];
    const generatedSeries: Series[] = [];
    const generatedEpisodes: Episode[] = [];

    payload.stores.projects.forEach((p: any) => {
      if (p.shots) {
        p.shots.forEach((s: any) => {
          if (s.videoModel === 'veo-r2v' || s.videoModel === 'veo') {
            s.videoModel = 'veo_3_1-fast';
          }
        });
      }
      if (!p.renderLogs) p.renderLogs = [];
      if (p.scriptData && !p.scriptData.props) p.scriptData.props = [];

      const genId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const projectId = genId('sproj');
      const seriesId = genId('series');
      const episodeId = genId('ep');

      const chars = p.scriptData?.characters || [];
      const scenes = p.scriptData?.scenes || [];
      const props = p.scriptData?.props || [];
      const episodeScenes = scenes.map((s: any) => ({ ...s, libraryId: s.id, libraryVersion: 1 }));
      const episodeProps = props.map((pr: any) => ({ ...pr, libraryId: pr.id, libraryVersion: 1 }));

      const sp: SeriesProject = {
        id: projectId,
        title: p.title,
        createdAt: p.createdAt || Date.now(),
        lastModified: p.lastModified || Date.now(),
        visualStyle: p.visualStyle || '3d-animation',
        language: p.language || '中文',
        artDirection: p.scriptData?.artDirection,
        characterLibrary: chars.map((c: any) => ({ ...c, version: 1 })),
        sceneLibrary: scenes.map((s: any) => ({ ...s, version: 1 })),
        propLibrary: props.map((pr: any) => ({ ...pr, version: 1 })),
      };
      generatedSeriesProjects.push(sp);

      const ser: Series = {
        id: seriesId,
        projectId,
        title: '第一季',
        sortOrder: 0,
        createdAt: Date.now(),
        lastModified: Date.now(),
      };
      generatedSeries.push(ser);

      const ep: Episode = {
        id: episodeId,
        projectId,
        seriesId,
        episodeNumber: 1,
        title: `第 1 集`,
        createdAt: p.createdAt || Date.now(),
        lastModified: p.lastModified || Date.now(),
        stage: p.stage || 'script',
        rawScript: p.rawScript || '',
        targetDuration: p.targetDuration || '60s',
        language: p.language || '中文',
        visualStyle: p.visualStyle || '3d-animation',
        shotGenerationModel: p.shotGenerationModel || 'gpt-5.2',
        scriptData: p.scriptData
          ? {
              ...p.scriptData,
              characters: chars.map((c: any) => ({ ...c, libraryId: c.id, libraryVersion: 1 })),
              scenes: episodeScenes,
              props: episodeProps,
            }
          : null,
        shots: p.shots || [],
        isParsingScript: false,
        renderLogs: p.renderLogs || [],
        characterRefs: chars.map((c: any) => ({ characterId: c.id, syncedVersion: 1, syncStatus: 'synced' as const })),
        sceneRefs: scenes.map((s: any) => ({ sceneId: s.id, syncedVersion: 1, syncStatus: 'synced' as const })),
        propRefs: props.map((pr: any) => ({ propId: pr.id, syncedVersion: 1, syncStatus: 'synced' as const })),
        promptTemplateOverrides: sanitizePromptTemplateOverrides(p.promptTemplateOverrides),
        scriptGenerationCheckpoint: null,
      };
      generatedEpisodes.push(normalizeEpisode(ep));
    });

    await Promise.all([
      batchUpsert('seriesProjects', generatedSeriesProjects),
      batchUpsert('series', generatedSeries),
      batchUpsert('episodes', generatedEpisodes),
    ]);

    count += generatedSeriesProjects.length + generatedSeries.length + generatedEpisodes.length;
  }

  return { projects: count, assets: assets.length };
};

// =============================================
// Utilities
// =============================================

export const convertImageToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('只支持图片文件')); return; }
    if (file.size > 10 * 1024 * 1024) { reject(new Error('图片大小不能超过 10MB')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
};
