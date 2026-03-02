/**
 * 模型配置管理服务（兼容层）
 *
 * 说明：原项目把 providers/models/active 写在 localStorage，并内置了特定平台（antsk）与默认模型。
 * 现在已切换为 services/modelRegistry.ts（服务端集中存储，默认空）。
 *
 * 这个文件保留给旧 UI（components/ModelManagerTab.tsx）使用：
 * - 不再读写 localStorage
 * - 不再注入任何默认 provider/model
 */

import type {
  ModelProvider,
  ModelConfig,
  ModelManagerState,
  AspectRatio,
  VideoDuration,
  ChatModelConfig,
  ImageModelConfig,
  VideoModelConfig,
} from '../types';

import {
  getRegistryState,
  saveRegistry,
  getProviders as getRegistryProviders,
  addProvider as addRegistryProvider,
  updateProvider as updateRegistryProvider,
  removeProvider as deleteRegistryProvider,
  getModels as getRegistryModels,
  getModelById,
  setActiveModel,
  getActiveChatModel,
  getActiveImageModel,
  getActiveVideoModel,
} from './modelRegistry';

// 这些偏好不属于“模型配置”，当前仍保持本地默认值（不强制云端）。
const DEFAULT_ASPECT_RATIO: AspectRatio = '16:9';
const DEFAULT_VIDEO_DURATION: VideoDuration = 8;

const emptyConfig = (): ModelConfig => {
  const chat = getActiveChatModel();
  const image = getActiveImageModel();
  const video = getActiveVideoModel();

  const chatConfig: ChatModelConfig = {
    providerId: chat?.providerId || '',
    modelName: chat?.id || '',
    endpoint: chat?.endpoint,
  };

  const imageConfig: ImageModelConfig = {
    providerId: image?.providerId || '',
    modelName: image?.id || '',
    endpoint: image?.endpoint,
  };

  const videoConfig: VideoModelConfig = {
    providerId: video?.providerId || '',
    type: (video as any)?.mode === 'sync' ? 'veo' : 'sora',
    modelName: video?.id || '',
    endpoint: video?.endpoint,
  };

  return {
    chatModel: chatConfig,
    imageModel: imageConfig,
    videoModel: videoConfig,
  };
};

export const loadModelConfig = (): ModelManagerState => {
  // 确保 registry 已在 index.tsx 里 initModelRegistry() 过；这里容错读取内存态。
  const providers = (getRegistryProviders() as any) as ModelProvider[];
  const currentConfig = emptyConfig();

  return {
    providers,
    currentConfig,
    defaultAspectRatio: DEFAULT_ASPECT_RATIO,
    defaultVideoDuration: DEFAULT_VIDEO_DURATION,
  };
};

export const saveModelConfig = (_state: ModelManagerState): void => {
  // no-op：ModelManagerTab 的变更通过下面的函数直接写入 modelRegistry。
};

export const getModelManagerState = (): ModelManagerState => loadModelConfig();

export const getProviders = (): ModelProvider[] => {
  return (getRegistryProviders() as any) as ModelProvider[];
};

export const getCurrentConfig = (): ModelConfig => emptyConfig();

export const addProvider = (provider: Omit<ModelProvider, 'id' | 'isBuiltIn'>): ModelProvider => {
  return (addRegistryProvider(provider as any) as any) as ModelProvider;
};

export const updateProvider = (id: string, updates: Partial<ModelProvider>): boolean => {
  return updateRegistryProvider(id, updates as any);
};

export const deleteProvider = (id: string): boolean => {
  return deleteRegistryProvider(id);
};

// =========================
// Active model selection
// =========================

export const updateChatModelConfig = (config: Partial<ChatModelConfig>): void => {
  const modelName = config.modelName?.trim();
  if (!modelName) {
    setActiveModel('chat', '');
    return;
  }

  // 兼容：允许传 model.id 或 apiModel
  const model = getModelById(modelName) || getRegistryModels('chat').find((m) => m.apiModel === modelName);
  setActiveModel('chat', model?.id || '');
};

export const updateImageModelConfig = (config: Partial<ImageModelConfig>): void => {
  const modelName = config.modelName?.trim();
  if (!modelName) {
    setActiveModel('image', '');
    return;
  }
  const model = getModelById(modelName) || getRegistryModels('image').find((m) => m.apiModel === modelName);
  setActiveModel('image', model?.id || '');
};

export const updateVideoModelConfig = (config: Partial<VideoModelConfig>): void => {
  const modelName = config.modelName?.trim();
  if (!modelName) {
    setActiveModel('video', '');
    return;
  }
  const model = getModelById(modelName) || getRegistryModels('video').find((m) => m.apiModel === modelName);
  setActiveModel('video', model?.id || '');
};

// =========================
// Preferences (kept local defaults for now)
// =========================

export const setDefaultAspectRatio = (_ratio: AspectRatio): void => {
  // 目前不做持久化；如你希望也云端保存，可以把它并入 config-api 的 schema。
};

export const setDefaultVideoDuration = (_duration: VideoDuration): void => {
  // no-op
};

// =========================
// Model options for UI
// =========================

export const AVAILABLE_CHAT_MODELS = () =>
  getRegistryModels('chat').map((m) => ({ name: m.name, value: m.id, description: m.description || '' }));

export const AVAILABLE_IMAGE_MODELS = () =>
  getRegistryModels('image').map((m) => ({ name: m.name, value: m.id, description: m.description || '' }));

export const AVAILABLE_VIDEO_MODELS = () =>
  getRegistryModels('video').map((m) => ({ name: m.name, value: m.id, description: m.description || '' }));

// =========================
// Advanced: direct registry write (not used by current UI)
// =========================

export const _dangerouslySetRegistryState = (state: any) => {
  saveRegistry(state);
};

export const _getRegistryState = () => getRegistryState();
