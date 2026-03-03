/**
 * 视频生成服务
 * 包含同步（chat/completions）和异步（/v1/videos、任务接口）模式
 */

import { AspectRatio, VideoDuration } from "../../types";
import { VideoApiSpec, VideoGenerateOptions } from "../../types/model";
import {
  retryOperation,
  checkApiKey,
  getApiBase,
  resolveModel,
  resolveRequestModel,
  parseHttpError,
  resizeImageToSize,
  getSoraVideoSize,
  getActiveModel,
} from './apiCore';

const VOLCENGINE_TASK_DEFAULT_ENDPOINT = '/api/v3/contents/generations/tasks';
const VOLCENGINE_DEFAULT_MODEL = 'doubao-seedance-1-5-pro-251215';

interface UnifiedVideoRequest extends VideoGenerateOptions {
  model: string;
}

interface VideoRequestRuntimeContext {
  apiKey: string;
  apiBase: string;
  endpoint?: string;
  requestModel: string;
  resolvedModelId: string;
  apiSpec: VideoApiSpec;
}

const normalizeImageInput = (image?: string): string | undefined => {
  if (!image) return undefined;
  const value = image.trim();
  return value || undefined;
};

const dedupeImageInputs = (images: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  images.forEach((image) => {
    const normalized = normalizeImageInput(image);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
};

const mapVolcengineRatio = (
  aspectRatio: AspectRatio,
  hasImageInput: boolean
): '16:9' | '9:16' | 'adaptive' => {
  if (hasImageInput) return 'adaptive';
  return aspectRatio === '9:16' ? '9:16' : '16:9';
};

const normalizeEndpoint = (endpoint?: string, fallback: string = '/v1/videos'): string => {
  const normalized = (endpoint || fallback).trim();
  if (!normalized) return fallback;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

const normalizeVideosEndpoint = (endpoint?: string): string => {
  const normalized = normalizeEndpoint(endpoint, '/v1/videos');
  return normalized.includes('/videos') ? normalized : '/v1/videos';
};

const normalizeChatEndpoint = (endpoint?: string): string => {
  const normalized = normalizeEndpoint(endpoint, '/v1/chat/completions');
  return normalized.includes('/chat/completions') ? normalized : '/v1/chat/completions';
};

const normalizeVolcengineTaskEndpoint = (endpoint?: string): string => {
  const normalized = normalizeEndpoint(endpoint, VOLCENGINE_TASK_DEFAULT_ENDPOINT);
  return normalized.includes('/contents/generations/tasks')
    ? normalized
    : VOLCENGINE_TASK_DEFAULT_ENDPOINT;
};

const resolveVideoApiSpec = (
  resolvedModel: any,
  resolvedEndpoint: string,
  requestModel: string
): VideoApiSpec => {
  const configuredSpec = resolvedModel?.params?.apiSpec as VideoApiSpec | undefined;
  if (configuredSpec) return configuredSpec;

  const endpoint = (resolvedEndpoint || '').toLowerCase();
  const modelName = (requestModel || resolvedModel?.id || '').toLowerCase();

  if (endpoint.includes('/contents/generations/tasks') || modelName.startsWith('doubao-seedance')) {
    return 'volcengine-task';
  }
  if (endpoint.includes('/chat/completions')) {
    return 'chat-completions';
  }
  if (endpoint.includes('/v1/videos') || modelName.startsWith('sora') || modelName.startsWith('veo_3_1-fast')) {
    return 'openai-videos';
  }
  return resolvedModel?.params?.mode === 'sync' ? 'chat-completions' : 'openai-videos';
};

const coerceVideoApiSpec = (
  runtimeContext: VideoRequestRuntimeContext
): VideoRequestRuntimeContext => {
  const modelName = (runtimeContext.requestModel || runtimeContext.resolvedModelId || '').toLowerCase();
  if (modelName.startsWith('veo_3_1-fast') || modelName.startsWith('sora')) {
    if (runtimeContext.apiSpec !== 'openai-videos') {
      console.warn(
        `⚠️ API spec override: model ${runtimeContext.requestModel || runtimeContext.resolvedModelId} ` +
        `should use openai-videos. Current spec=${runtimeContext.apiSpec}, auto-corrected.`
      );
    }
    return {
      ...runtimeContext,
      apiSpec: 'openai-videos',
      endpoint: normalizeVideosEndpoint(runtimeContext.endpoint),
    };
  }

  if (modelName.startsWith('doubao-seedance')) {
    return {
      ...runtimeContext,
      apiSpec: 'volcengine-task',
      endpoint: normalizeVolcengineTaskEndpoint(runtimeContext.endpoint),
    };
  }

  return runtimeContext;
};

// ============================================
// 异步视频生成
// ============================================

/**
 * 异步视频生成（单图走 sora-2，双图走 veo_3_1-fast）
 * 流程：1. 创建任务 -> 2. 轮询状态 -> 3. 下载视频
 */
const generateVideoAsync = async (
  request: UnifiedVideoRequest,
  context: VideoRequestRuntimeContext,
  aspectRatio: AspectRatio = '16:9',
  duration: VideoDuration = 8,
  allowDualRefFallback: boolean = true
): Promise<string> => {
  const { apiKey, apiBase, endpoint, requestModel } = context;
  const prompt = request.prompt;
  const startImageBase64 = normalizeImageInput(request.startImage);
  const endImageBase64 = normalizeImageInput(request.endImage);
  let references = dedupeImageInputs([
    startImageBase64,
    endImageBase64,
    ...(request.referenceImages || []),
  ]);
  const resolvedModelName = requestModel || 'sora-2';
  const useReferenceArray = resolvedModelName.toLowerCase().startsWith('veo_3_1-fast');
  if (resolvedModelName === 'sora-2' && references.length >= 2) {
    console.warn('⚠️ Capability routing: sora-2 only supports start-frame reference. End-frame reference will be ignored.');
    references = references.slice(0, 1);
  }

  if (resolvedModelName === 'sora-2' && references.length >= 2) {
    throw new Error('Sora-2 不支持首尾帧模式，请只传一张参考图。');
  }

  console.log(`🎬 使用异步模式生成视频 (${resolvedModelName}, ${aspectRatio}, ${duration}秒)...`);

  const videoSize = getSoraVideoSize(aspectRatio);
  const [VIDEO_WIDTH, VIDEO_HEIGHT] = videoSize.split('x').map(Number);

  console.log(`📐 视频尺寸: ${VIDEO_WIDTH}x${VIDEO_HEIGHT}`);

  const videosEndpoint = normalizeVideosEndpoint(endpoint);

  // Step 1: 创建视频任务
  const formData = new FormData();
  formData.append('model', resolvedModelName);
  formData.append('prompt', prompt);
  formData.append('seconds', String(duration));
  formData.append('size', videoSize);
  if (request.modelVersion) {
    formData.append('model_version', request.modelVersion);
  }

  const appendReference = async (base64: string, filename: string, fieldName: string) => {
    const cleanBase64 = base64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    console.log(`📐 调整参考图片尺寸至 ${VIDEO_WIDTH}x${VIDEO_HEIGHT}...`);
    const resizedBase64 = await resizeImageToSize(cleanBase64, VIDEO_WIDTH, VIDEO_HEIGHT);
    const byteCharacters = atob(resizedBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'image/png' });
    formData.append(fieldName, blob, filename);
  };

  if (useReferenceArray && references.length >= 2) {
    const limited = references.slice(0, 2);
    await appendReference(limited[0], 'reference-start.png', 'input_reference[]');
    await appendReference(limited[1], 'reference-end.png', 'input_reference[]');
  } else if (references.length >= 1) {
    await appendReference(references[0], 'reference.png', 'input_reference');
  }

  const metadata: Record<string, any> = { ...(request.metadata || {}) };
  if (request.modelVersion && metadata.model_version === undefined) {
    metadata.model_version = request.modelVersion;
  }
  if (startImageBase64?.startsWith('http') && metadata.first_frame_url === undefined) {
    metadata.first_frame_url = startImageBase64;
  }
  if (endImageBase64?.startsWith('http') && metadata.last_frame_url === undefined) {
    metadata.last_frame_url = endImageBase64;
  }
  if (Object.keys(metadata).length > 0) {
    formData.append('metadata', JSON.stringify(metadata));
  }

  if (request.providerOptions) {
    Object.entries(request.providerOptions).forEach(([key, value]) => {
      if (value === undefined || value === null) return;
      formData.append(key, String(value));
    });
  }

  if (references.length > 0) {
    console.log('✅ 参考图片已调整尺寸并添加');
  }

  const createResponse = await fetch(`${apiBase}${videosEndpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!createResponse.ok) {
    if (createResponse.status === 400) {
      throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
    }
    if (createResponse.status === 500) {
      throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
    }
    let errorMessage = `创建任务失败: HTTP ${createResponse.status}`;
    try {
      const errorData = await createResponse.json();
      errorMessage = errorData.error?.message || errorMessage;
    } catch (e) {
      const errorText = await createResponse.text();
      if (errorText) errorMessage = errorText;
    }
    throw new Error(errorMessage);
  }

  const createData = await createResponse.json();
  const taskId = createData.id || createData.task_id;
  if (!taskId) {
    throw new Error('创建视频任务失败：未返回任务ID');
  }

  console.log(`📋 ${resolvedModelName} 任务已创建，任务ID:`, taskId);

  // Step 2: 轮询查询任务状态
  const maxPollingTime = 1200000; // 20分钟超时
  const pollingInterval = 5000;
  const startTime = Date.now();

  let videoId: string | null = null;
  let videoUrlFromStatus: string | null = null;

  while (Date.now() - startTime < maxPollingTime) {
    await new Promise(resolve => setTimeout(resolve, pollingInterval));

    const statusResponse = await fetch(`${apiBase}${videosEndpoint}/${taskId}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    if (!statusResponse.ok) {
      console.warn('⚠️ 查询任务状态失败，继续重试...');
      continue;
    }

    const statusData = await statusResponse.json();
    const status = statusData.status;

    console.log(`🔄 ${resolvedModelName} 任务状态:`, status, '进度:', statusData.progress);

    if (status === 'completed' || status === 'succeeded') {
      videoUrlFromStatus = statusData.video_url || statusData.videoUrl || null;
      if (statusData.id && statusData.id.startsWith('video_')) {
        videoId = statusData.id;
      } else {
        videoId = statusData.output_video || statusData.video_id || statusData.outputs?.[0]?.id || statusData.id;
      }
      if (!videoId && statusData.outputs && statusData.outputs.length > 0) {
        videoId = statusData.outputs[0];
      }
      console.log('✅ 任务完成，视频ID:', videoId);
      break;
    } else if (status === 'failed' || status === 'error') {
      const errorMessage =
        statusData?.error?.message ||
        statusData?.error?.code ||
        statusData?.message ||
        '未知错误';
      if (allowDualRefFallback && useReferenceArray && references.length >= 2) {
        console.warn(
          `⚠️ ${resolvedModelName} 双参考任务失败，自动降级为单参考重试。原始错误: ${errorMessage}`
        );
        return generateVideoAsync(
          {
            ...request,
            startImage: references[0],
            endImage: undefined,
            referenceImages: [],
          },
          context,
          aspectRatio,
          duration,
          false
        );
      }
      throw new Error(`视频生成失败: ${errorMessage}`);
    }
  }

  if (!videoId && !videoUrlFromStatus) {
    throw new Error('视频生成超时 (20分钟) 或未返回视频ID');
  }

  console.log(`✅ ${resolvedModelName} 视频生成完成，视频ID:`, videoId);

  if (videoUrlFromStatus) {
    // Keep remote URL to avoid huge base64 payloads in cloud autosave.
    return videoUrlFromStatus;
  }

  // Step 3: 下载视频内容
  const maxDownloadRetries = 5;
  const downloadTimeout = 600000;

  for (let attempt = 1; attempt <= maxDownloadRetries; attempt++) {
    try {
      console.log(`📥 尝试下载视频 (第${attempt}/${maxDownloadRetries}次)...`);

      const downloadController = new AbortController();
      const downloadTimeoutId = setTimeout(() => downloadController.abort(), downloadTimeout);

      const downloadResponse = await fetch(`${apiBase}${videosEndpoint}/${videoId}/content`, {
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Authorization': `Bearer ${apiKey}`
        },
        signal: downloadController.signal
      });

      clearTimeout(downloadTimeoutId);

      if (!downloadResponse.ok) {
        if (downloadResponse.status >= 500 && attempt < maxDownloadRetries) {
          console.warn(`⚠️ 下载失败 HTTP ${downloadResponse.status}，${5 * attempt}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        throw new Error(`下载视频失败: HTTP ${downloadResponse.status}`);
      }

      const contentType = downloadResponse.headers.get('content-type');

      if (contentType && contentType.includes('video')) {
        const videoBlob = await downloadResponse.blob();
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            console.warn(`⚠️ ${resolvedModelName} 未返回可直接访问URL，回退为base64保存（可能导致存储体积较大）`);
            resolve(result);
          };
          reader.onerror = () => reject(new Error('视频转base64失败'));
          reader.readAsDataURL(videoBlob);
        });
      } else {
        const downloadData = await downloadResponse.json();
        const videoUrl = downloadData.url || downloadData.video_url || downloadData.download_url;

        if (!videoUrl) {
          throw new Error('未获取到视频下载地址');
        }

        return videoUrl;
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn(`⚠️ 下载超时，${5 * attempt}秒后重试...`);
        if (attempt < maxDownloadRetries) {
          await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
          continue;
        }
        throw new Error('下载视频超时 (10分钟)');
      }
      if (attempt === maxDownloadRetries) {
        throw error;
      }
      console.warn(`⚠️ 下载出错: ${error.message}，${5 * attempt}秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
    }
  }

  throw new Error('下载视频失败：已达最大重试次数');
};

const safeJsonParse = async (response: Response): Promise<any | null> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const getNestedValue = (obj: any, path: string): any => {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
};

const extractVideoUrlFromTaskPayload = (payload: any): string | null => {
  const candidatePaths = [
    'content.video_url',
    'content.videoUrl',
    'data.content.video_url',
    'data.content.videoUrl',
    'result.video_url',
    'result.videoUrl',
    'output.video_url',
    'output.videoUrl',
    'video_url',
    'videoUrl',
    'url',
  ];

  for (const path of candidatePaths) {
    const value = getNestedValue(payload, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

/**
 * 火山引擎任务模式视频生成
 * 流程：1) POST 创建任务 2) GET 轮询任务 3) 下载 video_url
 */
const generateVideoVolcengineTask = async (
  request: UnifiedVideoRequest,
  context: VideoRequestRuntimeContext,
  aspectRatio: AspectRatio = '16:9',
  duration: VideoDuration = 5
): Promise<string> => {
  const { apiKey, apiBase, endpoint, requestModel, resolvedModelId } = context;
  const prompt = request.prompt;
  const startImageBase64 = normalizeImageInput(request.startImage) || normalizeImageInput(request.referenceImages?.[0]);
  const endImageBase64 = normalizeImageInput(request.endImage);
  const taskEndpoint = normalizeVolcengineTaskEndpoint(endpoint);

  if (endImageBase64) {
    console.warn('⚠️ Volcengine task mode currently uses start-frame only. End frame will be ignored.');
  }

  const normalizeImageUrl = (image: string): string => {
    if (image.startsWith('http://') || image.startsWith('https://') || image.startsWith('data:image/')) {
      return image;
    }
    const clean = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    return `data:image/png;base64,${clean}`;
  };

  const content: any[] = [
    {
      type: 'text',
      text: prompt,
    },
  ];

  if (startImageBase64) {
    content.push({
      type: 'image_url',
      image_url: {
        url: normalizeImageUrl(startImageBase64),
      },
    });
  }

  const hasImageInput = !!startImageBase64;
  const ratio = mapVolcengineRatio(aspectRatio, hasImageInput);

  const createResponse = await fetch(`${apiBase}${taskEndpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: requestModel || resolvedModelId || VOLCENGINE_DEFAULT_MODEL,
      content,
      ratio,
      duration,
      watermark: false,
      ...(request.modelVersion ? { model_version: request.modelVersion } : {}),
      ...(request.providerOptions || {}),
    }),
  });

  if (!createResponse.ok) {
    if (createResponse.status === 400) {
      throw new Error('提示词或输入图片不符合要求，请调整后重试。');
    }
    if (createResponse.status >= 500) {
      throw new Error('火山引擎服务繁忙，请稍后重试。');
    }
    throw await parseHttpError(createResponse);
  }

  const createData = await safeJsonParse(createResponse);
  const taskId =
    createData?.id ||
    createData?.task_id ||
    createData?.data?.id ||
    createData?.data?.task_id;

  if (!taskId) {
    throw new Error('创建视频任务失败：未返回任务 ID');
  }

  console.log('📋 Volcengine 任务已创建，任务ID:', taskId);

  const pollingInterval = 5000;
  const maxPollingTime = 1200000; // 20 分钟
  const startTime = Date.now();
  const successStates = new Set(['succeeded', 'completed', 'success', 'done']);
  const failedStates = new Set(['failed', 'error', 'canceled', 'cancelled']);

  while (Date.now() - startTime < maxPollingTime) {
    await new Promise(resolve => setTimeout(resolve, pollingInterval));

    const statusResponse = await fetch(`${apiBase}${taskEndpoint}/${taskId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!statusResponse.ok) {
      console.warn('⚠️ Volcengine 任务查询失败，继续轮询...');
      continue;
    }

    const statusData = await safeJsonParse(statusResponse);
    const rawStatus = (
      statusData?.status ||
      statusData?.data?.status ||
      ''
    ).toString().toLowerCase();

    console.log('🔄 Volcengine 任务状态:', rawStatus || 'unknown');

    if (successStates.has(rawStatus)) {
      const videoUrl = extractVideoUrlFromTaskPayload(statusData);
      if (!videoUrl) {
        throw new Error('任务已完成，但未返回视频地址');
      }
      return videoUrl;
    }

    if (failedStates.has(rawStatus)) {
      const errorMessage =
        statusData?.error?.message ||
        statusData?.error?.code ||
        statusData?.message ||
        statusData?.msg ||
        '未知错误';
      throw new Error(`视频生成失败: ${errorMessage}`);
    }
  }

  throw new Error('视频生成超时 (20分钟)');
};

// ============================================
// 统一视频生成入口
// ============================================

/**
 * 生成视频
 * 支持同步（chat/completions）和异步（/v1/videos、任务接口）两种模式
 */
export const generateVideo = async (
  options: VideoGenerateOptions
): Promise<string> => {
  const unifiedRequest: UnifiedVideoRequest = {
    prompt: options.prompt,
    startImage: normalizeImageInput(options.startImage),
    endImage: normalizeImageInput(options.endImage),
    referenceImages: dedupeImageInputs(options.referenceImages || []),
    aspectRatio: options.aspectRatio || '16:9',
    duration: options.duration || 8,
    modelVersion: options.modelVersion,
    metadata: options.metadata || {},
    providerOptions: options.providerOptions,
    model: options.model || '',
  };
  const model = options.model || '';

  // Normalize legacy callers (e.g. 'sora-2') to the active video model.
  // resolveModel() returns undefined when the modelId isn't in registry.
  const resolvedVideoModel = resolveModel('video', model) || getActiveModel('video');
  const resolvedVideoModelId = (resolvedVideoModel as any)?.id || '';
  const requestModel = resolvedVideoModelId
    ? (resolveRequestModel('video', resolvedVideoModelId) || resolvedVideoModelId)
    : (resolveRequestModel('video', model) || '');

  const apiKey = checkApiKey('video', resolvedVideoModelId || model);
  const apiBase = getApiBase('video', resolvedVideoModelId || model);
  const resolvedEndpoint = (resolvedVideoModel as any)?.endpoint || '';
  const rawRuntimeContext: VideoRequestRuntimeContext = {
    apiKey,
    apiBase,
    endpoint: resolvedEndpoint,
    requestModel: requestModel || resolvedVideoModelId || '',
    resolvedModelId: resolvedVideoModelId || '',
    apiSpec: resolveVideoApiSpec(resolvedVideoModel, resolvedEndpoint, requestModel || resolvedVideoModelId || ''),
  };
  const runtimeContext = coerceVideoApiSpec(rawRuntimeContext);

  if (runtimeContext.apiSpec === 'volcengine-task') {
    return generateVideoVolcengineTask(
      unifiedRequest,
      runtimeContext,
      unifiedRequest.aspectRatio,
      unifiedRequest.duration
    );
  }

  // 异步模式
  if (runtimeContext.apiSpec === 'openai-videos') {
    return generateVideoAsync(
      unifiedRequest,
      runtimeContext,
      unifiedRequest.aspectRatio,
      unifiedRequest.duration
    );
  }

  // 同步模式：直接使用模型配置中的请求模型名
  const actualModel = runtimeContext.requestModel || 'sora-2';
  const chatEndpoint = normalizeChatEndpoint(runtimeContext.endpoint);

  const messages: any[] = [
    { role: 'user', content: unifiedRequest.prompt }
  ];

  const cleanStart = unifiedRequest.startImage?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';
  const cleanEnd = unifiedRequest.endImage?.replace(/^data:image\/(png|jpeg|jpg);base64,/, '') || '';

  if (cleanStart) {
    messages[0].content = [
      { type: 'text', text: unifiedRequest.prompt },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${cleanStart}` }
      }
    ];
  }

  if (cleanEnd) {
    if (Array.isArray(messages[0].content)) {
      messages[0].content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${cleanEnd}` }
      });
    }
  }

  const extraReferenceImages = dedupeImageInputs(unifiedRequest.referenceImages || []).filter(
    (img) => img !== unifiedRequest.startImage && img !== unifiedRequest.endImage
  );
  if (Array.isArray(messages[0].content) && extraReferenceImages.length > 0) {
    extraReferenceImages.slice(0, 4).forEach((image) => {
      const clean = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      messages[0].content.push({
        type: 'image_url',
        image_url: { url: clean.startsWith('http') ? image : `data:image/png;base64,${clean}` }
      });
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1200000);

  try {
    const response = await retryOperation(async () => {
      const res = await fetch(`${runtimeContext.apiBase}${chatEndpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runtimeContext.apiKey}`
        },
        body: JSON.stringify({
          model: actualModel,
          messages: messages,
          stream: false,
          temperature: 0.7,
          ...(unifiedRequest.modelVersion ? { model_version: unifiedRequest.modelVersion } : {}),
          ...(unifiedRequest.providerOptions || {}),
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        if (res.status === 400) {
          throw new Error('提示词可能包含不安全或违规内容，未能处理。请修改后重试。');
        }
        else if (res.status === 500) {
          throw new Error('当前请求较多，暂时未能处理成功，请稍后重试。');
        }

        let errorMessage = `HTTP错误: ${res.status}`;
        try {
          const errorData = await res.json();
          errorMessage = errorData.error?.message || errorMessage;
        } catch (e) {
          const errorText = await res.text();
          if (errorText) errorMessage = errorText;
        }
        throw new Error(errorMessage);
      }

      return res;
    });

    clearTimeout(timeoutId);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    const urlMatch = content.match(/(https?:\/\/[^\s]+\.mp4)/);
    const videoUrl = urlMatch ? urlMatch[1] : '';

    if (!videoUrl) {
      throw new Error("视频生成失败 (No video URL returned)");
    }

    return videoUrl;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('视频生成超时 (20分钟)');
    }
    throw error;
  }
};
