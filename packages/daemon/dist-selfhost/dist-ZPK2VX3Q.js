import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import {
  AssistantMessageFrameEncoder,
  StringEnum,
  contentText,
  createFauxCore,
  createImagesModels,
  createImagesProvider,
  envApiKeyAuth,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getOverflowPatterns,
  isContextOverflow,
  isRecoverableLength,
  isRetryableAssistantError,
  lazyOAuth,
  reduceAssistantMessageFrames,
  retryAssistantCall,
  validateToolArguments,
  validateToolCall
} from "./chunk-74UAPK2T.js";
import {
  typebox_exports
} from "./chunk-D7INORDC.js";
import {
  cleanupSessionResources,
  registerSessionResourceCleanup,
  uuidv7
} from "./chunk-G3XDTAZF.js";
import {
  parseJsonWithRepair,
  parseStreamingJson,
  repairJson
} from "./chunk-T34ZTHKA.js";
import "./chunk-RRL4GVXC.js";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  ModelsError,
  calculateCost,
  clampThinkingLevel,
  createModels,
  createProvider,
  defaultProviderAuthContext,
  getSupportedThinkingLevels,
  hasApi,
  lazyApi,
  lazyStream,
  modelsAreEqual
} from "./chunk-63Q43JGI.js";
import {
  AssistantMessageEventStream,
  EventStream,
  appendAssistantMessageDiagnostic,
  createAssistantMessageDiagnostic,
  createAssistantMessageEventStream,
  extractDiagnosticError,
  formatThrownValue
} from "./chunk-AJ7VZE7G.js";
import "./chunk-CB5SUWAA.js";
export {
  AssistantMessageEventStream,
  AssistantMessageFrameEncoder,
  EventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  ModelsError,
  StringEnum,
  typebox_exports as Type,
  appendAssistantMessageDiagnostic,
  calculateCost,
  clampThinkingLevel,
  cleanupSessionResources,
  contentText,
  createAssistantMessageDiagnostic,
  createAssistantMessageEventStream,
  createFauxCore,
  createImagesModels,
  createImagesProvider,
  createModels,
  createProvider,
  defaultProviderAuthContext,
  envApiKeyAuth,
  extractDiagnosticError,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  formatThrownValue,
  getOverflowPatterns,
  getSupportedThinkingLevels,
  hasApi,
  isContextOverflow,
  isRecoverableLength,
  isRetryableAssistantError,
  lazyApi,
  lazyOAuth,
  lazyStream,
  modelsAreEqual,
  parseJsonWithRepair,
  parseStreamingJson,
  reduceAssistantMessageFrames,
  registerSessionResourceCleanup,
  repairJson,
  retryAssistantCall,
  uuidv7,
  validateToolArguments,
  validateToolCall
};
