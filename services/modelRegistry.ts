/**
 * 模型注册中心
 * 管理所有已注册的模型，提供 CRUD 操作
 */

import {
  ModelType,
  ModelDefinition,
  ModelProvider,
  ModelRegistryState,
  ActiveModels,
  ChatModelDefinition,
  ImageModelDefinition,
  VideoModelDefinition,
  AspectRatio,
  VideoDuration,
} from '../types/model';

const MODEL_REGISTRY_ENDPOINT = '/api/config/model-registry';
const MODEL_REGISTRY_RESET_ENDPOINT = '/api/config/model-registry/reset';
const REQUEST_TIMEOUT_MS = 8000;

const normalizeBaseUrl = (url: string): string => url.trim().replace(/\/+$/, '').toLowerCase();

let registryState: ModelRegistryState | null = null;
let initPromise: Promise<ModelRegistryState> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

const getDefaultState = (): ModelRegistryState => ({
  providers: [],
  models: [],
  activeModels: {
    chat: '',
    image: '',
    video: '',
  },
  globalApiKey: undefined,
});

const withTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = item.id?.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const normalizeRegistryState = (raw: any): ModelRegistryState => {
  const providerCandidates: ModelProvider[] = (Array.isArray(raw?.providers) ? raw.providers : []).map((provider: any) => ({
    id: (provider?.id || '').trim(),
    name: (provider?.name || provider?.id || '').trim(),
    baseUrl: (provider?.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: provider?.apiKey?.trim() || undefined,
    isBuiltIn: Boolean(provider?.isBuiltIn),
    isDefault: Boolean(provider?.isDefault),
  }));
  const providers = dedupeById<ModelProvider>(providerCandidates);

  const providerIds = new Set(providers.map((provider) => provider.id));

  const modelCandidates: ModelDefinition[] = (Array.isArray(raw?.models) ? raw.models : [])
    .map((model: any) => {
      const id = (model?.id || '').trim();
      const apiModel = (model?.apiModel || '').trim() || id;
      return {
        ...model,
        id,
        apiModel,
        name: (model?.name || id).trim(),
        providerId: (model?.providerId || '').trim(),
        endpoint: model?.endpoint?.trim() || undefined,
        description: model?.description?.trim() || undefined,
        apiKey: model?.apiKey?.trim() || undefined,
        isBuiltIn: Boolean(model?.isBuiltIn),
        isEnabled: model?.isEnabled !== false,
      } as ModelDefinition;
    })
    .filter((model) => providerIds.has(model.providerId));
  const models = dedupeById<ModelDefinition>(modelCandidates);

  const enabledModelByType: Record<ModelType, string> = {
    chat: models.find((model) => model.type === 'chat' && model.isEnabled)?.id || '',
    image: models.find((model) => model.type === 'image' && model.isEnabled)?.id || '',
    video: models.find((model) => model.type === 'video' && model.isEnabled)?.id || '',
  };

  const requestedActive: ActiveModels = {
    chat: raw?.activeModels?.chat?.trim?.() || '',
    image: raw?.activeModels?.image?.trim?.() || '',
    video: raw?.activeModels?.video?.trim?.() || '',
  };

  const isValidActive = (type: ModelType, modelId: string): boolean => {
    if (!modelId) return false;
    return models.some((model) => model.type === type && model.id === modelId && model.isEnabled);
  };

  const activeModels: ActiveModels = {
    chat: isValidActive('chat', requestedActive.chat) ? requestedActive.chat : enabledModelByType.chat,
    image: isValidActive('image', requestedActive.image) ? requestedActive.image : enabledModelByType.image,
    video: isValidActive('video', requestedActive.video) ? requestedActive.video : enabledModelByType.video,
  };

  return {
    providers,
    models,
    activeModels,
    globalApiKey: raw?.globalApiKey?.trim?.() || undefined,
  };
};

const persistRegistryState = (state: ModelRegistryState): void => {
  const payload = JSON.stringify(state);
  persistQueue = persistQueue
    .then(async () => {
      try {
        await withTimeout(MODEL_REGISTRY_ENDPOINT, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
      } catch (error) {
        console.warn('保存模型注册中心到配置服务失败:', error);
      }
    })
    .catch(() => {
      // keep queue chain alive
    });
};

export const initModelRegistry = async (): Promise<ModelRegistryState> => {
  if (registryState) return registryState;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const response = await withTimeout(MODEL_REGISTRY_ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const remoteState = await response.json();
      const normalizedState = normalizeRegistryState(remoteState);
      registryState = normalizedState;
      return normalizedState;
    } catch (error) {
      console.error('初始化模型注册中心失败，云端配置不可用:', error);
      throw new Error('Cloud config service is unavailable. Please start config-api and retry.');
    }
  })();

  return initPromise;
};

export const loadRegistry = (): ModelRegistryState => {
  if (!registryState) {
    throw new Error('Model registry is not initialized. Call initModelRegistry() first.');
  }
  return registryState;
};

export const saveRegistry = (state: ModelRegistryState): void => {
  const normalized = normalizeRegistryState(state);
  registryState = normalized;
  persistRegistryState(normalized);
};

export const getRegistryState = (): ModelRegistryState => {
  return loadRegistry();
};

export const resetRegistry = (): void => {
  registryState = getDefaultState();
  persistQueue = persistQueue
    .then(async () => {
      try {
        await withTimeout(MODEL_REGISTRY_RESET_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        console.warn('重置远程模型注册中心失败:', error);
      }
    })
    .catch(() => {
      // keep queue chain alive
    });
};

// ============================================
// 提供商管理
// ============================================

export const getProviders = (): ModelProvider[] => {
  return loadRegistry().providers;
};

export const getProviderById = (id: string): ModelProvider | undefined => {
  return getProviders().find((provider) => provider.id === id);
};

export const getDefaultProvider = (): ModelProvider => {
  return getProviders().find((provider) => provider.isDefault) || getProviders()[0] || {
    id: '',
    name: '',
    baseUrl: '',
    isBuiltIn: false,
    isDefault: false,
  };
};

export const addProvider = (provider: Omit<ModelProvider, 'id' | 'isBuiltIn'>): ModelProvider => {
  const state = loadRegistry();
  const normalizedBaseUrl = normalizeBaseUrl(provider.baseUrl);
  const existing = state.providers.find((p) => normalizeBaseUrl(p.baseUrl) === normalizedBaseUrl);
  if (existing) return existing;

  const newProvider: ModelProvider = {
    ...provider,
    id: `provider_${Date.now()}`,
    baseUrl: provider.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: provider.apiKey?.trim() || undefined,
    isBuiltIn: false,
  };

  state.providers.push(newProvider);
  saveRegistry(state);
  return newProvider;
};

export const updateProvider = (id: string, updates: Partial<ModelProvider>): boolean => {
  const state = loadRegistry();
  const index = state.providers.findIndex((provider) => provider.id === id);
  if (index === -1) return false;

  if (state.providers[index].isBuiltIn) {
    delete updates.id;
    delete updates.isBuiltIn;
    delete updates.baseUrl;
  }

  const merged = {
    ...state.providers[index],
    ...updates,
  };

  if (typeof merged.baseUrl === 'string') {
    merged.baseUrl = merged.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof merged.apiKey === 'string') {
    merged.apiKey = merged.apiKey.trim() || undefined;
  }

  state.providers[index] = merged;
  saveRegistry(state);
  return true;
};

export const removeProvider = (id: string): boolean => {
  const state = loadRegistry();
  const provider = state.providers.find((item) => item.id === id);
  if (!provider || provider.isBuiltIn) return false;

  state.models = state.models.filter((model) => model.providerId !== id);
  state.providers = state.providers.filter((item) => item.id !== id);

  const active = state.activeModels;
  (['chat', 'image', 'video'] as ModelType[]).forEach((type) => {
    const activeModel = state.models.find((model) => model.type === type && model.id === active[type] && model.isEnabled);
    if (!activeModel) {
      active[type] = state.models.find((model) => model.type === type && model.isEnabled)?.id || '';
    }
  });

  saveRegistry(state);
  return true;
};

// ============================================
// 模型管理
// ============================================

export const getModels = (type?: ModelType): ModelDefinition[] => {
  const models = loadRegistry().models;
  return type ? models.filter((model) => model.type === type) : models;
};

export const getChatModels = (): ChatModelDefinition[] => {
  return getModels('chat') as ChatModelDefinition[];
};

export const getImageModels = (): ImageModelDefinition[] => {
  return getModels('image') as ImageModelDefinition[];
};

export const getVideoModels = (): VideoModelDefinition[] => {
  return getModels('video') as VideoModelDefinition[];
};

export const getModelById = (id: string): ModelDefinition | undefined => {
  return getModels().find((model) => model.id === id);
};

export const getActiveModel = (type: ModelType): ModelDefinition | undefined => {
  const state = loadRegistry();
  return getModelById(state.activeModels[type]);
};

export const getActiveChatModel = (): ChatModelDefinition | undefined => {
  return getActiveModel('chat') as ChatModelDefinition | undefined;
};

export const getActiveImageModel = (): ImageModelDefinition | undefined => {
  return getActiveModel('image') as ImageModelDefinition | undefined;
};

export const getActiveVideoModel = (): VideoModelDefinition | undefined => {
  return getActiveModel('video') as VideoModelDefinition | undefined;
};

export const setActiveModel = (type: ModelType, modelId: string): boolean => {
  const model = getModelById(modelId);
  if (!model || model.type !== type || !model.isEnabled) return false;

  const state = loadRegistry();
  state.activeModels[type] = modelId;
  saveRegistry(state);
  return true;
};

export const registerModel = (model: Omit<ModelDefinition, 'id' | 'isBuiltIn'> & { id?: string }): ModelDefinition => {
  const state = loadRegistry();

  const providedId = (model as any).id?.trim();
  const apiModel = (model as any).apiModel?.trim();
  const baseId = providedId || (apiModel ? `${model.providerId}:${apiModel}` : `model_${Date.now()}`);
  let modelId = baseId;

  if (!providedId) {
    let suffix = 1;
    while (state.models.some((item) => item.id === modelId)) {
      modelId = `${baseId}_${suffix++}`;
    }
  } else if (state.models.some((item) => item.id === modelId)) {
    throw new Error(`模型 ID "${modelId}" 已存在，请使用其他 ID`);
  }

  const newModel = {
    ...model,
    id: modelId,
    apiModel:
      apiModel ||
      (model.providerId && modelId.startsWith(`${model.providerId}:`)
        ? modelId.slice(model.providerId.length + 1)
        : modelId),
    isBuiltIn: false,
    apiKey: model.apiKey?.trim() || undefined,
  } as ModelDefinition;

  state.models.push(newModel);

  if (!state.activeModels[newModel.type]) {
    state.activeModels[newModel.type] = newModel.id;
  }

  saveRegistry(state);
  return newModel;
};

export const updateModel = (id: string, updates: Partial<ModelDefinition>): boolean => {
  const state = loadRegistry();
  const index = state.models.findIndex((model) => model.id === id);
  if (index === -1) return false;

  if (state.models[index].isBuiltIn) {
    const allowedUpdates: Partial<ModelDefinition> = {};
    if (updates.isEnabled !== undefined) allowedUpdates.isEnabled = updates.isEnabled;
    if (updates.params) allowedUpdates.params = updates.params as any;
    if (updates.apiKey !== undefined) allowedUpdates.apiKey = updates.apiKey?.trim() || undefined;
    state.models[index] = { ...state.models[index], ...allowedUpdates } as ModelDefinition;
  } else {
    const normalizedUpdates = { ...updates };
    if (typeof normalizedUpdates.apiKey === 'string') {
      normalizedUpdates.apiKey = normalizedUpdates.apiKey.trim() || undefined;
    }
    state.models[index] = { ...state.models[index], ...normalizedUpdates } as ModelDefinition;
  }

  if (state.activeModels[state.models[index].type] === id && !state.models[index].isEnabled) {
    state.activeModels[state.models[index].type] =
      state.models.find((model) => model.type === state.models[index].type && model.isEnabled && model.id !== id)?.id || '';
  }

  saveRegistry(state);
  return true;
};

export const removeModel = (id: string): boolean => {
  const state = loadRegistry();
  const model = state.models.find((item) => item.id === id);
  if (!model || model.isBuiltIn) return false;

  if (state.activeModels[model.type] === id) {
    const fallback = state.models.find((item) => item.type === model.type && item.id !== id && item.isEnabled);
    state.activeModels[model.type] = fallback?.id || '';
  }

  state.models = state.models.filter((item) => item.id !== id);
  saveRegistry(state);
  return true;
};

export const toggleModelEnabled = (id: string, enabled: boolean): boolean => {
  return updateModel(id, { isEnabled: enabled });
};

// ============================================
// API Key 管理
// ============================================

export const getGlobalApiKey = (): string | undefined => {
  return loadRegistry().globalApiKey;
};

export const setGlobalApiKey = (apiKey: string): void => {
  const state = loadRegistry();
  state.globalApiKey = apiKey?.trim() || undefined;
  saveRegistry(state);
};

export const getApiKeyForModel = (modelId: string): string | undefined => {
  const model = getModelById(modelId);
  if (!model) return getGlobalApiKey();

  if (model.apiKey) return model.apiKey;

  const provider = getProviderById(model.providerId);
  if (provider?.apiKey) return provider.apiKey;

  return getGlobalApiKey();
};

export const getApiBaseUrlForModel = (modelId: string): string => {
  const model = getModelById(modelId);
  if (!model) return '';

  const provider = getProviderById(model.providerId);
  return provider?.baseUrl?.replace(/\/+$/, '') || '';
};

// ============================================
// 辅助函数
// ============================================

export const getActiveModelsConfig = (): ActiveModels => {
  return loadRegistry().activeModels;
};

export const isModelAvailable = (modelId: string): boolean => {
  const model = getModelById(modelId);
  if (!model || !model.isEnabled) return false;
  return !!getApiKeyForModel(modelId);
};

export const getDefaultAspectRatio = (): AspectRatio => {
  const imageModel = getActiveImageModel();
  if (imageModel) return imageModel.params.defaultAspectRatio;
  return '16:9';
};

export const getUserAspectRatio = (): AspectRatio => {
  return getDefaultAspectRatio();
};

export const setUserAspectRatio = (ratio: AspectRatio): void => {
  const activeModel = getActiveImageModel();
  if (!activeModel) return;

  updateModel(activeModel.id, {
    params: { ...activeModel.params, defaultAspectRatio: ratio },
  } as any);
};

export const getDefaultVideoDuration = (): VideoDuration => {
  const videoModel = getActiveVideoModel();
  if (videoModel) return videoModel.params.defaultDuration;
  return 8;
};

export const getVideoModelType = (): 'sora' | 'veo' => {
  const videoModel = getActiveVideoModel();
  if (videoModel) {
    return videoModel.params.mode === 'async' ? 'sora' : 'veo';
  }
  return 'sora';
};
