import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store';

export const { setRuntime: setInstagramRuntime, getRuntime: getInstagramRuntime } =
  createPluginRuntimeStore({
    pluginId: 'instagram',
    errorMessage: 'Instagram runtime not initialized',
  });

