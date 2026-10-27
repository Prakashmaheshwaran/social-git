import { createPlatformCommandMac, type PlatformCommandMacHeaders } from "./platform-command-mac.ts";

/**
 * Reddit worker command MAC. The wire format is defined by `platformId`; the
 * display name only appears in error text. Reddit keeps its historical deferred
 * context validation order (`contextCheck: "deferred"`).
 */
const mac = createPlatformCommandMac({ platformId: "reddit", displayName: "Reddit", contextCheck: "deferred" });

export const REDDIT_COMMAND_MAC_CONTEXT = mac.context;
export const readRedditCommandKeyFile = mac.readCommandKeyFile;
export const RedditCommandMacSigner = mac.Signer;
export const RedditCommandMacVerifier = mac.Verifier;

export type RedditCommandMacHeaders = PlatformCommandMacHeaders;
export type RedditCommandMacSigner = InstanceType<typeof mac.Signer>;
export type RedditCommandMacVerifier = InstanceType<typeof mac.Verifier>;
