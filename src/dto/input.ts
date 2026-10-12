import type { ProxyConfigurationOptions } from 'apify';

/**
 * What `Actor.createProxyConfiguration` accepts. `useApifyProxy` is not part of
 * `ProxyConfigurationOptions` — it only exists to carry the Console's proxy editor's on/off
 * toggle — but it is exactly the field that arrives from the input schema, so it has to be here.
 */
export type ProxyInput = ProxyConfigurationOptions & { useApifyProxy?: boolean };
