import { createServer } from 'node:http';
import { URL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.CONFIG_API_PORT || 8788);
const DB_PATH = process.env.CONFIG_DB_PATH || '/data/config.db';
const MAX_BODY_BYTES = Number(process.env.CONFIG_API_MAX_BODY_BYTES || 1024 * 1024);

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

const selectStateStmt = db.prepare('SELECT value FROM configs WHERE key = ?');
const upsertStateStmt = db.prepare(`
  INSERT INTO configs (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const sendJson = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const normalizeString = (value) => (typeof value === 'string' ? value.trim() : '');

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
    const state = writeModelRegistryState(DEFAULT_STATE);
    sendJson(res, 200, state);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`config-api listening on :${PORT}, sqlite=${DB_PATH}`);
});
