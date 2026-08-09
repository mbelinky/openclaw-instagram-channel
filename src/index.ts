import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { instagramPlugin } from './openclaw/channel.js';
import { setInstagramRuntime } from './openclaw/runtime.js';

export default defineChannelPluginEntry({
  id: 'instagram',
  name: 'Instagram DMs',
  description: 'Instagram professional-account DMs via Instagram Login API',
  plugin: instagramPlugin,
  setRuntime: setInstagramRuntime,
});
