import { createServer } from 'node:http';
import { URL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.CONFIG_API_PORT || 8788);
const DB_PATH = process.env.CONFIG_DB_PATH || '/data/config.db';
const MAX_BODY_BYTES = Number(process.env.CONFIG_API_MAX_BODY_BYTES || 50 * 1024 * 1024);
const ENABLE_RESET = process.env.CONFIG_API_ENABLE_RESET === 'true';
const ADMIN_TOKEN = process.env.CONFIG_API_ADMIN_TOKEN || '';

const DEFAULT_STATE = {
  providers: [],
  models: [],
  activeModels: {
    chat: '',
    image: '',
    video: '',
  },
  globalApiKey: undefined,
};

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS configs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS storage_records (
    bucket TEXT NOT NULL,
    id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (bucket, id)
  )
`);

const selectStateStmt = db.prepare('SELECT value FROM configs WHERE key = ?');
const upsertStateStmt = db.prepare(`
  INSERT INTO configs (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const selectStorageByIdStmt = db.prepare('SELECT value FROM storage_records WHERE bucket = ? AND id = ?');
const selectStorageByBucketStmt = db.prepare('SELECT id, value FROM storage_records WHERE bucket = ? ORDER BY updated_at DESC');
const upsertStorageStmt = db.prepare(`
  INSERT INTO storage_records (bucket, id, value, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(bucket, id) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);
const deleteStorageByIdStmt = db.prepare('DELETE FROM storage_records WHERE bucket = ? AND id = ?');

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');
const ALLOWED_STORAGE_BUCKETS = new Set(['seriesProjects', 'series', 'episodes', 'assetLibrary']);

const dedupeById = (list) => {
  const seen = new Set();
  return list.filter((item) => {
    const id = normalizeString(item?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const normalizeState = (input) => {
  const rawProviders = Array.isArray(input?.providers) ? input.providers : [];
  const providers = dedupeById(rawProviders).map((provider) => ({
    id: normalizeString(provider.id),
    name: normalizeString(provider.name) || normalizeString(provider.id),
    baseUrl: normalizeString(provider.baseUrl).replace(/\/+$/, ''),
    apiKey: normalizeString(provider.apiKey) || undefined,
    isBuiltIn: Boolean(provider.isBuiltIn),
    isDefault: Boolean(provider.isDefault),
  }));

  const providerIds = new Set(providers.map((provider) => provider.id));
  const rawModels = Array.isArray(input?.models) ? input.models : [];
  const models = dedupeById(rawModels)
    .filter((model) => providerIds.has(normalizeString(model?.providerId)))
    .map((model) => {
      const id = normalizeString(model.id);
      const apiModel = normalizeString(model.apiModel) || id;
      return {
        ...model,
        id,
        apiModel,
        name: normalizeString(model.name) || id,
        providerId: normalizeString(model.providerId),
        endpoint: normalizeString(model.endpoint) || undefined,
        description: normalizeString(model.description) || undefined,
        apiKey: normalizeString(model.apiKey) || undefined,
        isBuiltIn: Boolean(model.isBuiltIn),
        isEnabled: model.isEnabled !== false,
      };
    });

  const enabledByType = {
    chat: models.find((model) => model.type === 'chat' && model.isEnabled)?.id || '',
    image: models.find((model) => model.type === 'image' && model.isEnabled)?.id || '',
    video: models.find((model) => model.type === 'video' && model.isEnabled)?.id || '',
  };

  const hasModel = (type, id) => models.some((model) => model.type === type && model.id === id && model.isEnabled);

  const activeModels = {
    chat: normalizeString(input?.activeModels?.chat),
    image: normalizeString(input?.activeModels?.image),
    video: normalizeString(input?.activeModels?.video),
  };

  if (!hasModel('chat', activeModels.chat)) activeModels.chat = enabledByType.chat;
  if (!hasModel('image', activeModels.image)) activeModels.image = enabledByType.image;
  if (!hasModel('video', activeModels.video)) activeModels.video = enabledByType.video;

  return {
    providers,
    models,
    activeModels,
    globalApiKey: normalizeString(input?.globalApiKey) || undefined,
  };
};

const readModelRegistryState = () => {
  const row = selectStateStmt.get('model-registry');
  if (!row?.value) {
    return { ...DEFAULT_STATE, activeModels: { ...DEFAULT_STATE.activeModels } };
  }

  try {
    const parsed = JSON.parse(row.value);
    return normalizeState(parsed);
  } catch {
    return { ...DEFAULT_STATE, activeModels: { ...DEFAULT_STATE.activeModels } };
  }
};

const writeModelRegistryState = (state) => {
  const normalized = normalizeState(state);
  upsertStateStmt.run('model-registry', JSON.stringify(normalized));
  return normalized;
};

const readJsonBody = (req, maxBytes) => new Promise((resolve, reject) => {
  let total = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > maxBytes) {
      reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (chunks.length === 0) {
      resolve({});
      return;
    }

    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      resolve(data);
    } catch {
      reject(Object.assign(new Error('Invalid JSON payload'), { statusCode: 400 }));
    }
  });

  req.on('error', (err) => {
    reject(Object.assign(err, { statusCode: 400 }));
  });
});

const parseStoragePath = (pathname) => {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  if (parts[0] !== 'api' || parts[1] !== 'config' || parts[2] !== 'storage') return null;
  const bucket = parts[3];
  const id = parts.length > 4 ? decodeURIComponent(parts.slice(4).join('/')) : '';
  return { bucket, id };
};

const assertValidBucket = (bucket) => {
  return ALLOWED_STORAGE_BUCKETS.has(bucket);
};

const parseStorageRows = (rows) => {
  const items = [];
  for (const row of rows || []) {
    try {
      const parsed = JSON.parse(row.value);
      if (parsed && typeof parsed === 'object') {
        if (!parsed.id && row.id) parsed.id = row.id;
        items.push(parsed);
      }
    } catch {
      // Skip malformed records.
    }
  }
  return items;
};

const server = createServer(async (req, res) => {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, dbPath: DB_PATH });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/config/model-registry') {
    const state = readModelRegistryState();
    sendJson(res, 200, state);
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/config/model-registry') {
    try {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const state = writeModelRegistryState(body);
      sendJson(res, 200, state);
      return;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error' : error.message });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/config/model-registry/reset') {
    if (!ENABLE_RESET) {
      sendJson(res, 403, { error: 'Reset is disabled' });
      return;
    }
    if (ADMIN_TOKEN) {
      const token = req.headers['x-config-admin-token'];
      if (token !== ADMIN_TOKEN) {
        sendJson(res, 401, { error: 'Invalid admin token' });
        return;
      }
    }
    const state = writeModelRegistryState(DEFAULT_STATE);
    sendJson(res, 200, state);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/config/storage/batch-upsert') {
    try {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const bucket = normalizeString(body?.bucket);
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!assertValidBucket(bucket)) {
        sendJson(res, 400, { error: 'Invalid bucket' });
        return;
      }
      for (const item of items) {
        const id = normalizeString(item?.id);
        if (!id) continue;
        upsertStorageStmt.run(bucket, id, JSON.stringify({ ...item, id }));
      }
      sendJson(res, 200, { ok: true, count: items.length });
      return;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error' : error.message });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/api/config/storage/batch-delete') {
    try {
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      const bucket = normalizeString(body?.bucket);
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      if (!assertValidBucket(bucket)) {
        sendJson(res, 400, { error: 'Invalid bucket' });
        return;
      }
      for (const rawId of ids) {
        const id = normalizeString(rawId);
        if (!id) continue;
        deleteStorageByIdStmt.run(bucket, id);
      }
      sendJson(res, 200, { ok: true, count: ids.length });
      return;
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error' : error.message });
      return;
    }
  }

  const storagePath = parseStoragePath(url.pathname);
  if (storagePath) {
    const { bucket, id } = storagePath;
    if (!assertValidBucket(bucket)) {
      sendJson(res, 400, { error: 'Invalid bucket' });
      return;
    }

    if (method === 'GET' && !id) {
      const field = normalizeString(url.searchParams.get('field'));
      const value = normalizeString(url.searchParams.get('value'));
      let items = parseStorageRows(selectStorageByBucketStmt.all(bucket));
      if (field && value) {
        items = items.filter((item) => normalizeString(item?.[field]) === value);
      }
      sendJson(res, 200, { items });
      return;
    }

    if (method === 'GET' && id) {
      const row = selectStorageByIdStmt.get(bucket, id);
      if (!row?.value) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object' && !parsed.id) parsed.id = id;
        sendJson(res, 200, { item: parsed });
      } catch {
        sendJson(res, 500, { error: 'Corrupted record' });
      }
      return;
    }

    if (method === 'PUT' && id) {
      try {
        const body = await readJsonBody(req, MAX_BODY_BYTES);
        const normalized = { ...body, id };
        upsertStorageStmt.run(bucket, id, JSON.stringify(normalized));
        sendJson(res, 200, { item: normalized });
      } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error' : error.message });
      }
      return;
    }

    if (method === 'DELETE' && id) {
      deleteStorageByIdStmt.run(bucket, id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`config-api listening on :${PORT}, sqlite=${DB_PATH}`);
});
