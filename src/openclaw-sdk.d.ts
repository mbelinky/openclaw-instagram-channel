declare module 'openclaw/plugin-sdk/channel-core' {
  export function defineChannelPluginEntry(params: any): any;
  export function defineSetupPluginEntry(params: any): any;
  export function createChatChannelPlugin<TAccount = any>(params: any): any;
}

declare module 'openclaw/plugin-sdk/channel-outbound' {
  export function createChannelMessageAdapterFromOutbound(params: any): any;
  export function createMessageReceiptFromOutboundResults(params: any): any;
}

declare module 'openclaw/plugin-sdk/channel-policy' {
  export function createRestrictSendersChannelSecurity<TAccount = any>(params: any): any;
}

declare module 'openclaw/plugin-sdk/channel-send-result' {
  export function createAttachedChannelResultAdapter(params: {
    channel: string;
    sendText?: (ctx: {
      cfg: any;
      to: string;
      text: string;
      accountId?: string;
      signal?: AbortSignal;
      deps?: any;
    }) => Promise<any>;
  }): any;
}

declare module 'openclaw/plugin-sdk/channel-inbound' {
  export function dispatchInboundDirectDmWithRuntime(params: any): Promise<any>;
}

declare module 'openclaw/plugin-sdk/command-auth' {
  export function shouldComputeCommandAuthorized(text?: string, cfg?: any, options?: any): boolean;
}

declare module 'openclaw/plugin-sdk/webhook-ingress' {
  export function registerPluginHttpRoute(params: any): () => void;
}

declare module 'openclaw/plugin-sdk/runtime-store' {
  export function createPluginRuntimeStore(params: {
    pluginId: string;
    errorMessage: string;
  }): {
    setRuntime: (runtime: any) => void;
    getRuntime: () => any;
  };
}

declare module 'openclaw/plugin-sdk/plugin-runtime' {
  export function getGlobalHookRunner(): any;
}

declare module 'openclaw/plugin-sdk/hook-runtime' {
  export function buildCanonicalSentMessageHookContext(params: any): any;
  export function toPluginMessageSentEvent(canonical: any): any;
  export function toPluginMessageContext(canonical: any): any;
  export function fireAndForgetHook(promise: Promise<any>, label: string): void;
}
